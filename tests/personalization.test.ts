import test from 'node:test';
import assert from 'node:assert/strict';
import {rankPersonalized,mixExploration} from '../lib/personalization.ts';
import {DEFAULT_INTELLIGENCE} from '../lib/intelligence-types.ts';
import type { Article, Preferences } from '../lib/types.ts';
const preferences:Preferences={interests:['開発'],mutedTopics:[],topicWeights:{},sourceWeights:{},diversity:0};
const article=(id:string,tags=['開発']):Article=>({id,title:id,description:'',url:'https://example.com/'+id,sourceId:id,sourceName:id,publishedAt:new Date().toISOString(),tags,readingMinutes:3});
test('AI評価がある記事を意味評価の関心度で並べ、重要度を独立して保持する',()=>{const a=article('a'),b=article('b');const intel={...DEFAULT_INTELLIGENCE,analysis:{a:{articleId:'a',interest:20,importance:98,reason:'社会への影響',importanceReason:'大規模な変更',summary:'概要'},b:{articleId:'b',interest:90,importance:10,reason:'実践的',importanceReason:'個別事例',summary:'概要'}}};const r=rankPersonalized([a,b],preferences,{},intel);assert.equal(r[0].id,'b');assert.equal(r.find(x=>x.id==='a')?.importance,98);});
test('AI評価後でも本人の興味なしとmuteを優先し、保存一覧では保持する',()=>{const a=article('a');assert.equal(rankPersonalized([a],preferences,{a:'dislike'},DEFAULT_INTELLIGENCE).length,0);assert.equal(rankPersonalized([a],preferences,{a:'dislike'},DEFAULT_INTELLIGENCE,true).length,1);});
test('探索割合0では追加せず、20%では上位10件に探索記事を2件混ぜる',()=>{const normal=rankPersonalized(Array.from({length:12},(_,i)=>article('a'+i)),preferences,{},DEFAULT_INTELLIGENCE);const extra=[article('science1',['サイエンス']),article('science2',['暮らし'])];assert.deepEqual(mixExploration(normal,extra,0),normal);const mixed=mixExploration(normal,extra,20);assert.equal(mixed.slice(0,10).filter(x=>x.isExploration).length,2);assert.equal(new Set(mixed.map(x=>x.id)).size,mixed.length);});

test('表示用の評価値をAPI送信や記事保存に混入させない',async()=>{
 const {toArticle}=await import('../lib/personalization.ts');
 const {validateRequest}=await import('../lib/ai.ts');
 const {validateSyncDocument}=await import('../lib/cloud-library.ts');
 const ranked=rankPersonalized([article('dto')],preferences,{},DEFAULT_INTELLIGENCE)[0];
 const clean=toArticle({...ranked,content:'本文'});
 assert.equal('importance' in clean,false);
 assert.doesNotThrow(()=>validateRequest({action:'analyze',articles:[clean]}));
 const reader={version:1 as const,articles:[clean],feeds:[],saved:[],read:[],feedback:{},preferences,lastUpdated:null};
 assert.equal(validateSyncDocument({version:2,reader,intelligence:DEFAULT_INTELLIGENCE,updatedAt:new Date().toISOString()}),true);
});

test('AIで評価した記事は、規則のタグの代わりにAIのタグを使う', () => {
  const tagged = { ...DEFAULT_INTELLIGENCE, analysis: { a: { articleId: 'a', interest: 50, importance: 50, summary: '', reason: 'r', importanceReason: 'i', tags: ['カルチャー'] } } };
  const article = { id: 'a', title: '見出し', description: '', url: 'https://e.com/a', sourceId: 's', sourceName: 'S', publishedAt: '2026-11-09T00:00:00Z', tags: ['テクノロジー'], readingMinutes: 3 };
  const [ranked] = rankPersonalized([article], { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 0 }, {}, tagged);
  assert.deepEqual(ranked.tags, ['カルチャー']);
  // AIのタグが無い（以前の評価）ときは規則のタグのまま。
  const old = { ...DEFAULT_INTELLIGENCE, analysis: { a: { articleId: 'a', interest: 50, importance: 50, summary: '', reason: 'r', importanceReason: 'i' } } };
  assert.deepEqual(rankPersonalized([article], { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 0 }, {}, old)[0].tags, ['テクノロジー']);
  // AIのタグが空なら、規則のタグを消さない。
  const empty = { ...DEFAULT_INTELLIGENCE, analysis: { a: { articleId: 'a', interest: 50, importance: 50, summary: '', reason: 'r', importanceReason: 'i', tags: [] } } };
  assert.deepEqual(rankPersonalized([article], { interests: [], mutedTopics: [], topicWeights: {}, sourceWeights: {}, diversity: 0 }, {}, empty)[0].tags, ['テクノロジー']);
});
