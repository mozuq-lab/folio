import test from 'node:test';
import assert from 'node:assert/strict';
import {retainedArticleIds} from '../lib/retention.ts';
import {DEFAULT_INTELLIGENCE} from '../lib/intelligence-types.ts';
import type { ReaderState } from '../lib/types.ts';
const reader:ReaderState={version:1,articles:[],feeds:[],saved:['saved'],read:['read'],feedback:{},preferences:{interests:[],mutedTopics:[],topicWeights:{},sourceWeights:{},diversity:0},lastUpdated:null};
test('購読解除や更新後もノート・要約・回答の出典を保護する',()=>{const intel={...DEFAULT_INTELLIGENCE,notes:[{id:'n',articleId:'noted',quote:'',body:'メモ',createdAt:'',updatedAt:''}],digest:{title:'',overview:'',mode:'ai' as const,items:[{articleId:'digest',summary:'',takeaway:'',minutes:1}],totalMinutes:1,generatedAt:''},chats:[{id:'chat',question:'',result:{answer:'',citations:[{articleId:'cited',quote:''}]},createdAt:''}]};const ids=retainedArticleIds(reader,intel);assert.deepEqual(new Set(ids),new Set(['saved','noted','digest','cited']));});
