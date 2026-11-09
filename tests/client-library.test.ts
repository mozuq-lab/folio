import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCache, LibrarySyncController, type LibraryCache } from '../lib/client-library.ts';
import { DEFAULT_INTELLIGENCE, type CloudLibrary } from '../lib/intelligence-types.ts';
import type { ReaderState } from '../lib/types.ts';
const reader=():ReaderState=>({version:1,articles:[],feeds:[],saved:[],read:[],feedback:{},preferences:{interests:[],mutedTopics:[],topicWeights:{},sourceWeights:{},diversity:30},lastUpdated:null});
const local=():LibraryCache=>({document:{version:2,reader:reader(),intelligence:structuredClone(DEFAULT_INTELLIGENCE),updatedAt:'2026-11-06T00:00:00Z'},revision:0,pending:false});
const cloud=(cache:LibraryCache,revision=1):CloudLibrary=>({document:structuredClone(cache.document),revision,updatedAt:'2026-11-06T00:00:00Z',userName:'読者',ownerId:'alice'});
const json=(body:unknown,status=200)=>Response.json(body,{status});

test('旧cacheの保存・既読・ノート用記事本文を失わずv2へ移行する',()=>{
  const old=reader();old.saved=['a'];old.read=['a'];old.feedback={a:'like'};old.articles=[{id:'a',title:'記事',description:'概要',url:'https://example.com/a',sourceId:'s',sourceName:'Source',publishedAt:'now',tags:[],readingMinutes:1,content:'本文を保持',contentFetchedAt:'now'}];
  const result=decodeCache(null,reader(),JSON.stringify(old));
  assert.equal(result.cache.pending,true);assert.equal(result.cache.revision,0);assert.equal(result.cache.document.reader.articles[0].content,'本文を保持');assert.deepEqual(result.cache.document.reader.saved,['a']);assert.equal(result.storageWarning,false);
});
test('reloadでpendingとrevisionを保持し破損cacheは警告してfallbackする',()=>{
  const cache=local();cache.pending=true;cache.revision=7;cache.document.intelligence.instructions='未送信';
  const restored=decodeCache(JSON.stringify(cache),reader());assert.equal(restored.cache.pending,true);assert.equal(restored.cache.revision,7);assert.equal(restored.cache.document.intelligence.instructions,'未送信');
  const invalid=decodeCache('{invalid',reader());assert.equal(invalid.storageWarning,true);assert.equal(invalid.cache.pending,false);
});
test('初回はcloudを採用しhydrateだけでは不要なPUTを送らない',async()=>{
  const remote=local();remote.document.reader.saved=['cloud'];const methods:string[]=[];
  const controller=new LibrarySyncController(local(),{fetcher:async(_url,init)=>{methods.push(init?.method||'GET');return json(cloud(remote,4));}});
  await controller.hydrate();assert.equal(controller.view.ready,true);assert.equal(controller.view.status,'synced');assert.deepEqual(controller.view.cache.document.reader.saved,['cloud']);assert.equal(controller.view.cache.revision,4);assert.equal(controller.view.userName,'読者');assert.deepEqual(methods,['GET']);
});
test('空cloudへの移行ではreaderとintelligenceを一体で保存する',async()=>{
  const sent:Record<string,unknown>[]=[];
  const controller=new LibrarySyncController(local(),{fetcher:async(_url,init)=>{
    if(init?.method==='PUT'){const payload=JSON.parse(String(init.body));sent.push(payload);return json({document:payload.document,revision:1,updatedAt:'now',ownerId:'alice'});}
    return json({document:null,revision:0,updatedAt:null,ownerId:'alice'});
  }});
  await controller.hydrate();controller.editReader(state=>({...state,saved:['a']}));controller.editIntelligence(state=>({...state,instructions:'日本語で'}));await controller.flush();
  assert.equal(sent.length,1);assert.equal(sent[0].baseRevision,0);assert.deepEqual((sent[0].document as LibraryCache['document']).reader.saved,['a']);assert.equal((sent[0].document as LibraryCache['document']).intelligence.instructions,'日本語で');assert.equal(controller.view.cache.pending,false);
});
test('未送信の編集とcloudのrevisionが違う時はhydrateで競合を提示する',async()=>{
  const cache=local();cache.pending=true;cache.revision=1;cache.document.intelligence.instructions='手元';
  const remote=local();remote.document.intelligence.instructions='別端末';
  const controller=new LibrarySyncController(cache,{fetcher:async()=>json(cloud(remote,2))});
  await controller.hydrate();assert.equal(controller.view.status,'conflict');assert.equal(controller.view.cache.document.intelligence.instructions,'手元');assert.equal(controller.view.conflict?.document?.intelligence.instructions,'別端末');
  await controller.resolveConflict('cloud');assert.equal(controller.view.cache.document.intelligence.instructions,'別端末');assert.equal(controller.view.cache.pending,false);assert.equal(controller.view.cache.revision,2);
});
test('409で同期を止めlocal解決は返された最新revisionを使って再送する',async()=>{
  const cache=local();cache.revision=1;cache.pending=true;const bases:number[]=[];let attempts=0;
  const controller=new LibrarySyncController(cache,{fetcher:async(_url,init)=>{
    if(!init?.method||init.method==='GET')return json(cloud(cache,1));
    const payload=JSON.parse(String(init.body));bases.push(payload.baseRevision);
    if(++attempts===1)return json({error:'競合',current:cloud(local(),3)},409);
    return json({document:payload.document,revision:4,updatedAt:'now',ownerId:'alice'});
  }});
  await controller.hydrate();await controller.flush();assert.equal(controller.view.status,'conflict');await controller.flush();assert.equal(attempts,1);
  await controller.resolveConflict('local');assert.deepEqual(bases,[1,3]);assert.equal(controller.view.status,'synced');assert.equal(controller.view.cache.revision,4);
});
test('PUT中の追加編集は直列に続けて保存し多重PUTしない',async()=>{
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let attempts=0;let active=0;let maxActive=0;const bodies:LibraryCache['document'][]=[];
  const controller=new LibrarySyncController(local(),{fetcher:async(_url,init)=>{
    if(init?.method!=='PUT')return json({document:null,revision:0,updatedAt:null,ownerId:'alice'});
    active++;maxActive=Math.max(maxActive,active);const payload=JSON.parse(String(init.body));bodies.push(payload.document);if(++attempts===1)await gate;active--;return json({document:payload.document,revision:attempts,updatedAt:'now',ownerId:'alice'});
  }});
  await controller.hydrate();controller.editReader(state=>({...state,saved:['first']}));const sending=controller.flush();controller.editIntelligence(state=>({...state,instructions:'途中の編集'}));const duplicate=controller.flush();release();await Promise.all([sending,duplicate]);
  assert.equal(maxActive,1);assert.equal(attempts,2);assert.equal(bodies[1].intelligence.instructions,'途中の編集');assert.deepEqual(bodies[1].reader.saved,['first']);assert.equal(controller.view.cache.pending,false);
});
test('401と503はlocal、network失敗はofflineで未送信編集を保持する',async()=>{
  for(const status of [401,503]) {
    const controller=new LibrarySyncController(local(),{fetcher:async()=>json({error:'未接続です'},status)});await controller.hydrate();assert.equal(controller.view.ready,true);assert.equal(controller.view.status,'local');controller.editReader(state=>({...state,saved:['pending']}));assert.equal(controller.view.cache.pending,true);
  }
  const controller=new LibrarySyncController(local(),{fetcher:async()=>{throw new TypeError('Failed to fetch');}});await controller.hydrate();assert.equal(controller.view.status,'offline');assert.equal(controller.view.ready,true);
});
test('4MBを超える編集は送信せずcacheとbackup対象の内容を残してerrorにする',async()=>{
  let puts=0;const persisted:LibraryCache[]=[];
  const controller=new LibrarySyncController(local(),{persist:cache=>persisted.push(structuredClone(cache)),fetcher:async(_url,init)=>{if(init?.method==='PUT')puts++;return json({document:null,revision:0,updatedAt:null,ownerId:'alice'});}});
  await controller.hydrate();const huge='あ'.repeat(1500000);controller.editIntelligence(state=>({...state,instructions:huge}));await controller.flush();assert.equal(controller.view.status,'error');assert.equal(puts,0);assert.equal(controller.view.cache.document.intelligence.instructions,huge);assert.equal(persisted.at(-1)?.pending,true);
});
test('再hydrate中の編集はGET完了後に保存し古い応答で新しい編集を消さない',async()=>{
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let gets=0;let puts=0;let waiting=false;let putDuringGet=false;
  const cache=local();cache.revision=1;
  const controller=new LibrarySyncController(cache,{fetcher:async(_url,init)=>{
    if(init?.method==='PUT'){puts++;putDuringGet=waiting;const payload=JSON.parse(String(init.body));return json({document:payload.document,revision:2,updatedAt:'now',ownerId:'alice'});}
    if(++gets===2){waiting=true;await gate;waiting=false;}return json(cloud(cache,1));
  }});
  await controller.hydrate();const refreshing=controller.hydrate();controller.editReader(state=>({...state,saved:['new']}));const sending=controller.flush();await new Promise(resolve=>setImmediate(resolve));assert.equal(puts,0);release();await Promise.all([refreshing,sending]);
  assert.equal(putDuringGet,false);assert.deepEqual(controller.view.cache.document.reader.saved,['new']);assert.equal(controller.view.cache.revision,2);
});

test('大きなcacheはreloadでも切り捨てずpendingとownerを復元する',()=>{
  const cache=local();cache.pending=true;cache.ownerId='alice';cache.document.intelligence.instructions='あ'.repeat(1500000);
  const result=decodeCache(JSON.stringify(cache),reader());assert.equal(result.storageWarning,false);assert.equal(result.cache.ownerId,'alice');assert.equal(result.cache.document.intelligence.instructions.length,1500000);assert.equal(result.cache.pending,true);
});
test('AのcacheからBの空cloudへ切り替えた時にAの内容を送信しない',async()=>{
  const cache=local();cache.ownerId='alice';cache.pending=true;cache.document.reader.saved=['private-A'];const backups:LibraryCache[]=[];const sent:LibraryCache['document'][]=[];
  const controller=new LibrarySyncController(cache,{fallbackReader:reader(),backup:old=>backups.push(old),fetcher:async(_url,init)=>{
    if(init?.method==='PUT'){const body=JSON.parse(String(init.body));sent.push(body.document);return json({document:body.document,revision:1,updatedAt:'now',ownerId:'bob'});}
    return json({document:null,revision:0,updatedAt:null,ownerId:'bob'});
  }});
  assert.deepEqual(controller.view.cache.document.reader.saved,[]);assert.equal(controller.view.ready,false);
  await controller.hydrate();await controller.flush();assert.deepEqual(controller.view.cache.document.reader.saved,[]);assert.equal(controller.view.cache.ownerId,'bob');assert.deepEqual(backups[0].document.reader.saved,['private-A']);assert.ok(sent.every(document=>!document.reader.saved.includes('private-A')));
});
test('401ではownedcacheを退避して非表示にしofflineでは端末内閲覧を許可する',async()=>{
  const cache=local();cache.ownerId='alice';cache.document.reader.saved=['private-A'];const backups:LibraryCache[]=[];
  const signedOut=new LibrarySyncController(cache,{fallbackReader:reader(),backup:old=>backups.push(old),fetcher:async()=>json({error:'ログインしてください'},401)});
  await signedOut.hydrate();assert.deepEqual(signedOut.view.cache.document.reader.saved,[]);assert.equal(signedOut.view.cache.ownerId,undefined);assert.equal(backups.length,1);
  const offline=new LibrarySyncController(cache,{fallbackReader:reader(),fetcher:async()=>{throw new TypeError('offline');}});await offline.hydrate();assert.equal(offline.view.status,'offline');assert.deepEqual(offline.view.cache.document.reader.saved,['private-A']);
});
test('GET後のuser切替をPUTのexpectedOwnerIdで検出して新owner内容を採用する',async()=>{
  const cache=local();cache.ownerId='alice';cache.pending=true;cache.revision=1;const sentOwners:string[]=[];const backups:LibraryCache[]=[];
  const remote=cloud(local(),3);remote.ownerId='bob';remote.document!.reader.saved=['B'];
  const controller=new LibrarySyncController(cache,{fallbackReader:reader(),backup:old=>backups.push(old),fetcher:async(_url,init)=>{
    if(init?.method!=='PUT')return json(cloud(cache,1));
    sentOwners.push(JSON.parse(String(init.body)).expectedOwnerId);return json({error:'owner changed',current:remote},409);
  }});
  await controller.hydrate();await controller.flush();assert.deepEqual(sentOwners,['alice']);assert.equal(controller.view.cache.ownerId,'bob');assert.deepEqual(controller.view.cache.document.reader.saved,['B']);assert.equal(controller.view.conflict,null);assert.equal(backups.length,1);
});

test('aiなしのcacheもai付きのcacheも復元できる',()=>{
  const cache=local();
  assert.equal(decodeCache(JSON.stringify(cache),reader()).storageWarning,false);
  cache.document.intelligence.ai={provider:'anthropic',models:{anthropic:'claude-haiku-5-5'},efforts:{anthropic:'high'}};
  const restored=decodeCache(JSON.stringify(cache),reader());
  assert.equal(restored.storageWarning,false);assert.deepEqual(restored.cache.document.intelligence.ai,cache.document.intelligence.ai);
});
test('verifiedOwnerIdはサーバーが確かめた持ち主だけを示し、端末のcacheの持ち主は使わない',async()=>{
  const cache=local();cache.ownerId='alice';
  const offline=new LibrarySyncController(cache,{fallbackReader:reader(),fetcher:async()=>{throw new TypeError('offline');}});
  assert.equal(offline.view.verifiedOwnerId,null);await offline.hydrate();assert.equal(offline.view.cache.ownerId,'alice');assert.equal(offline.view.verifiedOwnerId,null);
  let mode:'ok'|'offline'|'signedOut'='ok';
  const controller=new LibrarySyncController(cache,{fallbackReader:reader(),fetcher:async()=>{if(mode==='offline')throw new TypeError('offline');return mode==='ok'?json(cloud(cache,1)):json({error:'ログインしてください'},401);}});
  await controller.hydrate();assert.equal(controller.view.verifiedOwnerId,'alice');
  // 確かめた後に通信が切れても、同じ持ち主のまま使える。
  mode='offline';await controller.hydrate();assert.equal(controller.view.status,'offline');assert.equal(controller.view.verifiedOwnerId,'alice');
  mode='signedOut';await controller.hydrate();assert.equal(controller.view.verifiedOwnerId,null);
  const unavailable=new LibrarySyncController(local(),{fallbackReader:reader(),fetcher:async()=>json({error:'未接続です',ownerId:'carol'},503)});
  await unavailable.hydrate();assert.equal(unavailable.view.verifiedOwnerId,'carol');
});
