import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { createTestD1 } from './helpers/d1.ts';
import { getCloudLibrary, putCloudLibrary, LibraryConflictError, validateSyncDocument, type LibraryDatabase } from '../lib/cloud-library.ts';
import { DEFAULT_INTELLIGENCE, type SyncDocument } from '../lib/intelligence-types.ts';

function document(): SyncDocument {
  return { version:2, reader:{version:1,articles:[],feeds:[],saved:[],read:[],feedback:{},preferences:{interests:[],mutedTopics:[],topicWeights:{},sourceWeights:{},diversity:30},lastUpdated:null},intelligence:structuredClone(DEFAULT_INTELLIGENCE),updatedAt:'2026-11-06T00:00:00.000Z' };
}
function database(): LibraryDatabase & { sqlite:DatabaseSync } {
  return createTestD1() as unknown as LibraryDatabase & { sqlite:DatabaseSync };
}
test('初回は空、保存後はuser単位で復元しSQLを含むIDも値として扱う',async()=>{
  const db=database();
  assert.deepEqual(await getCloudLibrary(db,'alice'),{document:null,revision:0,updatedAt:null,ownerId:'alice'});
  const saved=await putCloudLibrary(db,"alice'; DROP TABLE folio_libraries;--",document(),0);
  assert.equal(saved.revision,1);assert.deepEqual(saved.document,document());
  assert.equal((await getCloudLibrary(db,'bob')).document,null);
  assert.equal((await getCloudLibrary(db,"alice'; DROP TABLE folio_libraries;--")).revision,1);
});
test('最新revisionだけ更新し、古い端末の保存では現在の内容を409相当で返す',async()=>{
  const db=database();await putCloudLibrary(db,'alice',document(),0);
  const changed=document();changed.intelligence.instructions='最新の編集';
  assert.equal((await putCloudLibrary(db,'alice',changed,1)).revision,2);
  await assert.rejects(putCloudLibrary(db,'alice',document(),1),(error:unknown)=>error instanceof LibraryConflictError&&error.current.revision===2&&error.current.document?.intelligence.instructions==='最新の編集');
});
test('初回保存同士の競合も既存データを上書きしない',async()=>{
  const db=database();const results=await Promise.allSettled([putCloudLibrary(db,'alice',document(),0),putCloudLibrary(db,'alice',document(),0)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejected=results.find(result=>result.status==='rejected');assert.ok(rejected&&rejected.status==='rejected'&&rejected.reason instanceof LibraryConflictError);
  assert.equal((await getCloudLibrary(db,'alice')).revision,1);
});
test('不正なschema、prototype用key、NaN、不正な拡張フィールドを拒否する',()=>{
  assert.equal(validateSyncDocument(document()),true);
  for(const bad of [null,{...document(),version:1},{...document(),extra:'bad'},{...document(),reader:{...document().reader,articles:[{id:'partial'}]}},{...document(),intelligence:{...document().intelligence,exploration:NaN}},{...document(),intelligence:{...document().intelligence,notes:[{id:'x',articleId:'a',quote:'q',body:'b',createdAt:'now',updatedAt:3}]}}]) assert.equal(validateSyncDocument(bad),false);
  const unsafe=JSON.parse(JSON.stringify(document()));unsafe.reader.preferences.topicWeights=JSON.parse('{"__proto__":1}');assert.equal(validateSyncDocument(unsafe),false);
  const wrongContent=JSON.parse(JSON.stringify(document()));wrongContent.reader.articles=[{id:'a',title:'a',description:'',url:'https://example.com',sourceId:'s',sourceName:'s',publishedAt:'now',tags:[],readingMinutes:1,content:{bad:true}}];assert.equal(validateSyncDocument(wrongContent),false);
});
test('priority付きのfeedは通り、priorityの無いfeedも通る',()=>{
  const base={id:'f',name:'n',url:'https://example.com/f.xml',website:'https://example.com',category:'c',color:'#000',initial:'F'};
  for(const feeds of [[base],[{...base,priority:true}],[{...base,priority:false}]]){const d=document();d.reader.feeds=feeds;assert.equal(validateSyncDocument(d),true);}
  const bad=document();bad.reader.feeds=[{...base,priority:'yes'}] as never;assert.equal(validateSyncDocument(bad),false);
});
test('4MBを超えるdocumentと不正revisionは保存しない',async()=>{
  const db=database();const oversized=document();oversized.intelligence.instructions='あ'.repeat(1500000);
  assert.equal(validateSyncDocument(oversized),true);
  await assert.rejects(putCloudLibrary(db,'alice',oversized,0));
  for(const revision of [-1,0.5,NaN,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(putCloudLibrary(db,'alice',document(),revision));
  assert.equal((await getCloudLibrary(db,'alice')).document,null);
});

test('D1の2MB binding/row制限でも4MB近い文書を分割して完全復元する',async()=>{
  const db=database();const large=document();large.intelligence.instructions='漢😀'.repeat(550000);
  const saved=await putCloudLibrary(db,'alice',large,0);
  assert.equal(saved.ownerId,'alice');assert.deepEqual((await getCloudLibrary(db,'alice')).document,large);
  const rows=db.sqlite.prepare('SELECT content FROM folio_library_chunks WHERE user_id = ?').all('alice');
  assert.ok(rows.length>=4);for(const row of rows)assert.ok(new TextEncoder().encode(String(row.content)).byteLength<2000000);
  const updated=document();updated.intelligence.instructions='更新後';await putCloudLibrary(db,'alice',updated,1);
  assert.equal((await getCloudLibrary(db,'alice')).document?.intelligence.instructions,'更新後');
  assert.equal(db.sqlite.prepare('SELECT COUNT(DISTINCT operation_token) AS n FROM folio_library_chunks').get()?.n,1);
});
test('同時chunk更新で勝者と敗者の断片を混ぜず旧revisionを更新しない',async()=>{
  const db=database();await putCloudLibrary(db,'alice',document(),0);
  const first=document();first.intelligence.instructions='A'.repeat(2100000);const second=document();second.intelligence.instructions='B'.repeat(2100000);
  const results=await Promise.allSettled([putCloudLibrary(db,'alice',first,1),putCloudLibrary(db,'alice',second,1)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const saved=await getCloudLibrary(db,'alice');assert.equal(saved.revision,2);assert.equal(saved.document?.intelligence.instructions,first.intelligence.instructions);
  assert.equal(db.sqlite.prepare('SELECT COUNT(DISTINCT operation_token) AS n FROM folio_library_chunks').get()?.n,1);
});
test('chunk保存失敗時はmetadataのrevisionも全断片もrollbackする',async()=>{
  const db=database();await putCloudLibrary(db,'alice',document(),0);
  db.sqlite.exec("CREATE TRIGGER reject_chunk BEFORE INSERT ON folio_library_chunks WHEN NEW.part = 1 BEGIN SELECT RAISE(ABORT, 'chunk failure'); END");
  const changed=document();changed.intelligence.instructions='X'.repeat(2100000);
  await assert.rejects(putCloudLibrary(db,'alice',changed,1),/chunk failure/);
  const saved=await getCloudLibrary(db,'alice');assert.equal(saved.revision,1);assert.deepEqual(saved.document,document());
});
test('旧document直書きrowも読めて次の保存からchunk形式へ移行できる',async()=>{
  const db=database();db.sqlite.prepare('INSERT INTO folio_libraries VALUES (?, ?, 5, ?)').run('alice',JSON.stringify(document()),'now');
  assert.deepEqual((await getCloudLibrary(db,'alice')).document,document());
  assert.equal((await putCloudLibrary(db,'alice',document(),5)).revision,6);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM folio_library_chunks').get()?.n,1);
});
test('GET後に認証ownerが切り替わっても期待ownerと違うuserへ書き込まない',async()=>{
  const db=database();const privateDocument=document();privateDocument.reader.saved=['private-A'];
  await assert.rejects(putCloudLibrary(db,'bob',privateDocument,0,'alice'),(error:unknown)=>error instanceof LibraryConflictError&&error.current.ownerId==='bob'&&error.current.document===null);
  assert.equal((await getCloudLibrary(db,'bob')).document,null);
});
test('AI設定: aiなしの既存文書とai付き文書を受け付け、不正な値と未知キーを拒否する',()=>{
  const withAi=(ai:unknown)=>{const doc=document() as unknown as {intelligence:Record<string,unknown>};doc.intelligence.ai=ai;return doc;};
  assert.equal('ai' in document().intelligence,false);assert.equal(validateSyncDocument(document()),true);
  assert.equal(validateSyncDocument(withAi({provider:'anthropic',models:{anthropic:'claude-haiku-5-5'},efforts:{anthropic:'high'}})),true);
  assert.equal(validateSyncDocument(withAi({provider:'workers-ai',models:{},efforts:{}})),true);
  for(const bad of [
    {provider:'gemini',models:{},efforts:{}},
    {provider:'openai',models:{openai:'bad id'},efforts:{}},
    {provider:'openai',models:{},efforts:{openai:'extreme'}},
    {provider:'openai',models:{unknown:'x'},efforts:{}},
    {provider:'openai',models:{},efforts:{unknown:'high'}},
    {provider:'openai',models:{},efforts:{},extra:1},
    {provider:'openai',models:{}},
    null,
  ]) assert.equal(validateSyncDocument(withAi(bad)),false,JSON.stringify(bad));
});
