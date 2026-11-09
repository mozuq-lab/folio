import type { ReaderState } from './types.ts';
import type { IntelligenceState } from './intelligence-types.ts';
export function retainedArticleIds(reader:ReaderState,intelligence:IntelligenceState):string[]{return [...new Set([...reader.saved,...intelligence.notes.map(n=>n.articleId),...(intelligence.digest?.items.map(x=>x.articleId)||[]),...intelligence.chats.flatMap(c=>c.result.citations.map(x=>x.articleId))])];}
/** 「ニュースのまとまり」をなくしたので、保存済みの比較結果を消す。無ければ同じオブジェクトを返す。 */
export function clearStoryReports(intelligence:IntelligenceState):IntelligenceState{return Object.keys(intelligence.storyReports).length?{...intelligence,storyReports:{}}:intelligence;}
