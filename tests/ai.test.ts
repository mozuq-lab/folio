import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { AIError, runAI, validateRequest } from '../lib/ai.ts';
import type { Article } from '../lib/types.ts';
import type { AIRequest } from '../lib/intelligence-types.ts';
import type { AIProvider, StructuredRequest, StructuredResult } from '../lib/ai/types.ts';
const article: Article = { id:'a', title:'交通研究', description:'交通調査では移動時間が短縮した。', content:'交通調査では移動時間が短縮した。対象は一地域の住民で、他地域への適用は未確認。', url:'https://example.com/a', sourceId:'s', sourceName:'通信', publishedAt:'2026-11-06T00:00:00Z', tags:[], readingMinutes:2 };
const request = (action:AIRequest['action']):AIRequest => ({ action, articles:[article], question:'何が分かった？', instruction:'研究を優先', budgetMinutes:5, readIds:['a'] });
const fake = (generate:(request:StructuredRequest)=>Promise<StructuredResult>|StructuredResult):AIProvider => ({id:'openai',generate:async request=>generate(request)});
const returning = (json:unknown):AIProvider => fake(()=>({kind:'ok',json}));
const runtime = (provider:AIProvider,effort:'auto'|'medium'|'high'='medium') => ({provider,model:'test-model',effort});
const ask = {kind:'ask',result:{answer:'対象地域で移動時間が短縮しました。',citations:[{articleId:'a',quote:'移動時間が短縮した。'}]}};
test('不正action・記事上限・重複ID・予算・未知の既読/ノート参照を拒否する', () => {
  for(const value of [{action:'invalid',articles:[]},{...request('analyze'),articles:Array.from({length:51},(_,i)=>({...article,id:String(i)}))},{...request('digest'),articles:Array.from({length:31},(_,i)=>({...article,id:String(i)}))},{...request('ask'),articles:[article,article]},{...request('digest'),budgetMinutes:31},{...request('compare'),readIds:['unknown']},{...request('ask'),notes:[{id:'n',articleId:'other',quote:'',body:'note',createdAt:'now',updatedAt:'now'}]}]) assert.throws(()=>validateRequest(value),AIError);
});
test('存在しない記事と本文にないquoteを成功として返さない',async()=>{
  for(const result of [{kind:'ask',result:{answer:'回答',citations:[{articleId:'other',quote:'交通'}]}},{kind:'ask',result:{answer:'回答',citations:[{articleId:'a',quote:'架空の引用'}]}}]) await assert.rejects(runAI(request('ask'),runtime(returning(result))),AIError);
});
test('引用0件なら根拠という単語や断定を含む回答もアプリの根拠不足メッセージへ置換する',async()=>{
  for(const answer of ['根拠は十分です。全住民に効果がありました。','対象は世界全体です','記事内の根拠が不足しています。しかし全住民に効果がありました。','記事内の根拠が不足しているため確認できません。']) {
    const result=await runAI(request('ask'),runtime(returning({kind:'ask',result:{answer,citations:[]}})));
    assert.deepEqual(result,{kind:'ask',result:{answer:'保存記事から回答の根拠を見つけられませんでした。質問を具体的にするか、関連する記事を保存してください。',citations:[]}});
  }
});
test('analyzeは関心と重要度を独立に返し、不正scoreと空の結果を拒否する',async()=>{
  const analysis={articleId:'a',interest:10,importance:90,summary:'',reason:'関心との一致は小さい',importanceReason:'交通政策への影響'};
  assert.deepEqual(await runAI(request('analyze'),runtime(returning({kind:'analyze',analysis:[analysis]}))),{kind:'analyze',analysis:[analysis]});
  for(const list of [[],[{...analysis,importance:101}],[{...analysis,articleId:'unknown'}]]) await assert.rejects(runAI(request('analyze'),runtime(returning({kind:'analyze',analysis:list}))),AIError);
});
test('analyzeは50件まで送れ、重複・不明なIDは除き、評価できなかった記事は結果に含めない',async()=>{
  const many=Array.from({length:50},(_,i)=>({...article,id:`a${i}`,description:'',content:undefined}));
  const item=(id:string)=>({articleId:id,interest:50,importance:50,summary:'',reason:'r',importanceReason:'i'});
  const result=await runAI({action:'analyze',articles:many,instruction:''},runtime(returning({kind:'analyze',analysis:[item('a0'),item('a0'),item('zz'),item('a1')]})));
  assert.deepEqual(result.kind==='analyze'&&result.analysis.map(a=>a.articleId),['a0','a1']);
});
test('analyzeの指示は、見出しだけで評価し、summaryを空にして理由を短くするよう求める',async()=>{
  let seen='';
  await runAI(request('analyze'),runtime(fake(r=>{seen=r.instructions;return {kind:'ok',json:{kind:'analyze',analysis:[{articleId:'a',interest:1,importance:1,summary:'',reason:'r',importanceReason:'i'}]}};})));
  assert.ok(seen.includes('summaryは空文字')&&seen.includes('40字以内'));
});
test('自然文をNaturalProfileに構造化し、未定義フィールドとenumを拒否する',async()=>{
  const result={kind:'preferences',profile:{summary:'研究を優先',boostTerms:['研究'],muteTerms:[],preferredDepth:'advanced'}};
  assert.deepEqual(await runAI({action:'preferences',articles:[],instruction:'研究を優先'},runtime(returning(result))),result);
  await assert.rejects(runAI(request('preferences'),runtime(returning({...result,profile:{...result.profile,preferredDepth:'secret'}}))),AIError);
});
test('digestは記事参照と時間予算と合計を厳守し、modeをaiに限定する',async()=>{
  const digest={title:'今日のまとめ',overview:'交通研究',items:[{articleId:'a',summary:'概要',takeaway:'地域差に注意',minutes:2}],totalMinutes:2,generatedAt:'2026-11-06T00:00:00Z',mode:'ai'};
  const result=await runAI(request('digest'),runtime(returning({kind:'digest',digest})));
  assert.equal(result.kind,'digest');if(result.kind==='digest') assert.equal(result.digest.totalMinutes,2);
  for(const change of [{totalMinutes:3},{items:[{...digest.items[0],minutes:6}],totalMinutes:6},{mode:'extractive'}]) await assert.rejects(runAI(request('digest'),runtime(returning({kind:'digest',digest:{...digest,...change}}))),AIError);
});
test('compareは既読集合を渡し媒体とarticleIdsの一致を検証する',async()=>{
  const report={overview:'既読との差分',developments:[{text:'続報は未確認',articleIds:['a']}],perspectives:[{sourceName:'通信',point:'地域調査の視点',articleIds:['a']}],uncertainties:['他地域への適用']};
  assert.deepEqual(await runAI(request('compare'),runtime(returning({kind:'compare',report}))),{kind:'compare',report});
  await assert.rejects(runAI(request('compare'),runtime(returning({kind:'compare',report:{...report,perspectives:[{...report.perspectives[0],sourceName:'別媒体'}]}}))),AIError);
});
test('好みの構造化では操作に不要な記事とノートを外部送信しない',async()=>{
  const result={kind:'preferences',profile:{summary:'研究を優先',boostTerms:['研究'],muteTerms:[],preferredDepth:'any'}};
  await runAI(request('preferences'),runtime(fake(r=>{
    const data=JSON.parse(r.input);
    assert.deepEqual(data.articles,[]);assert.equal(data.notes,undefined);assert.equal(data.question,undefined);
    return {kind:'ok',json:result};
  })));
});
test('refusedは422、incompleteは502 incomplete_outputで固定文言を返す',async()=>{
  await assert.rejects(runAI(request('ask'),runtime(fake(()=>({kind:'refused'})))),(e:unknown)=>e instanceof AIError&&e.status===422&&e.code==='refused');
  await assert.rejects(runAI(request('ask'),runtime(fake(()=>({kind:'incomplete'})))),(e:unknown)=>e instanceof AIError&&e.status===502&&e.code==='incomplete_output'&&e.message==='AIの出力が途中で終わりました。推論の深さを下げるか対象記事を減らしてください。');
});
test('signalのabortで投げたら504、その他の例外は502 network_error、AIErrorはそのまま',async()=>{
  await assert.rejects(runAI(request('ask'),runtime(fake(()=>{throw new DOMException('Aborted','AbortError');}))),(e:unknown)=>e instanceof AIError&&e.status===504&&e.code==='timeout');
  await assert.rejects(runAI(request('ask'),runtime(fake(()=>{throw new Error('boom secret');}))),(e:unknown)=>e instanceof AIError&&e.status===502&&e.code==='network_error'&&!e.message.includes('secret'));
  await assert.rejects(runAI(request('ask'),runtime(fake(()=>{throw new AIError(502,'invalid_output','x');}))),(e:unknown)=>e instanceof AIError&&e.code==='invalid_output');
});
test('providerへモデル・effort・出力上限・schema名・signalを渡し、指示と入力を分離する',async()=>{
  let seen:StructuredRequest|undefined;
  await runAI(request('ask'),runtime(fake(r=>{seen=r;return {kind:'ok',json:ask};}),'high'));
  assert.ok(seen);
  assert.equal(seen.model,'test-model');assert.equal(seen.effort,'high');assert.equal(seen.maxOutputTokens,32000);assert.equal(seen.schemaName,'folio_ask');assert.ok(seen.signal);
  assert.ok(seen.instructions.includes('未取得')&&!seen.instructions.includes('交通研究'));assert.ok(seen.input.includes('交通研究'));
});
test('timeoutはeffortに応じ、時間切れでsignalがabortされ504になる',async()=>{
  for(const [effort,ms] of [['auto',90_000],['medium',180_000],['high',240_000]] as const){
    mock.timers.enable({apis:['setTimeout']});
    try{
      const pending=runAI(request('ask'),runtime(fake(r=>new Promise((_,reject)=>r.signal.addEventListener('abort',()=>reject(new Error('aborted'))))),effort));
      const assertion=assert.rejects(pending,(e:unknown)=>e instanceof AIError&&e.status===504);
      mock.timers.tick(ms-1);await Promise.resolve();
      mock.timers.tick(1);
      await assertion;
    }finally{mock.timers.reset();}
  }
});
test('analyzeの理由は80字、要約は200字までに切り詰めて返す',async()=>{
  const long={articleId:'a',interest:1,importance:1,summary:'あ'.repeat(600),reason:'い'.repeat(300),importanceReason:'う'.repeat(300)};
  const result=await runAI(request('analyze'),runtime(returning({kind:'analyze',analysis:[long]})));
  assert.ok(result.kind==='analyze');
  assert.equal(result.analysis[0].summary.length,200);assert.equal(result.analysis[0].reason.length,80);assert.equal(result.analysis[0].importanceReason.length,80);
});
