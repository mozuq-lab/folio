import type { ReaderState } from './types.ts';
import type { IntelligenceState } from './intelligence-types.ts';
export function retainedArticleIds(reader:ReaderState,intelligence:IntelligenceState):string[]{return [...new Set([...reader.saved,...reader.read,...intelligence.notes.map(n=>n.articleId),...(intelligence.digest?.items.map(x=>x.articleId)||[]),...intelligence.chats.flatMap(c=>c.result.citations.map(x=>x.articleId)),...Object.values(intelligence.storyReports).flatMap(r=>[...r.developments.flatMap(x=>x.articleIds),...r.perspectives.flatMap(x=>x.articleIds)])])];}
