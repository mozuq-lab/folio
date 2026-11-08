import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeState, mergeArticles, mergeSubscribedArticles } from '../lib/storage.ts';
import type { ReaderState, Article } from '../lib/types.ts';
const fallback: ReaderState = { version:1, articles:[], feeds:[], saved:[], read:[], feedback:{}, preferences:{interests:[],mutedTopics:[],topicWeights:{},sourceWeights:{},diversity:30},lastUpdated:null };
test('破損した保存データは初期値へ戻る',()=>{ assert.deepEqual(decodeState('{invalid',fallback),fallback); assert.deepEqual(decodeState('{"version":1,"articles":"bad"}',fallback),fallback); });
test('不正なpreferencesは初期値へ戻る',()=>{ assert.deepEqual(decodeState(JSON.stringify({...fallback,preferences:{interests:null}}),fallback),fallback); });
test('feedbackと保存記事を復元する',()=>{ const state={...fallback,saved:['one'],feedback:{one:'like' as const}};assert.deepEqual(decodeState(JSON.stringify(state),fallback),state); });
const a=(id:string):Article=>({id,title:id,description:'',url:'https://example.com/'+id,sourceId:'source',sourceName:'Source',publishedAt:new Date().toISOString(),tags:[],readingMinutes:2});
test('更新時に保存済み記事を保持してURL重複を除外する',()=>{const old=a('old'),fresh=a('fresh'); assert.deepEqual(mergeArticles([old],[fresh,fresh],['old']).map(x=>x.id),['fresh','old']); });
test('更新時に未更新の別ソースの記事を保持する',()=>{const other={...a('other'),sourceId:'other'};assert.deepEqual(mergeArticles([other],[a('new')],[]).map(x=>x.id),['new','other']);});
test('同じURLの記事のGUIDが変わっても保存済みIDを保つ',()=>{const old=a('saved-guid');const updated={...old,id:'new-guid',title:'更新されたタイトル'};const result=mergeArticles([old],[updated],['saved-guid']);assert.equal(result.length,1);assert.equal(result[0].id,'saved-guid');assert.equal(result[0].title,'更新されたタイトル');});
test('同じ記事が別ソースから届いても既読やfeedback用のIDを保つ',()=>{const old=a('old-guid');const updated={...old,id:'new-guid',sourceId:'another'};assert.equal(mergeArticles([old],[updated],[])[0].id,'old-guid');});

test('更新の完了前に購読解除したソースの記事を復活させない',()=>{assert.deepEqual(mergeSubscribedArticles([], [a('late')], [], []),[]);});
test('RSS再取得でも取得済み本文を失わない',()=>{const old={...a('full'),content:'取得済み本文',contentFetchedAt:'2026-11-06T00:00:00Z'};const result=mergeArticles([old],[a('full')],[]);assert.equal(result[0].content,'取得済み本文');});
