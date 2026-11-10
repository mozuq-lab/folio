export interface Article {
  id: string;
  title: string;
  description: string;
  url: string;
  image?: string;
  sourceId: string;
  sourceName: string;
  publishedAt: string;
  tags: string[];
  readingMinutes: number;
  isSample?: boolean;
  content?: string;
  contentFetchedAt?: string;
}
export interface Feed {
  id: string;
  name: string;
  url: string;
  website: string;
  category: string;
  color: string;
  initial: string;
  priority?: boolean;
}
export interface Preferences {
  interests: string[];
  mutedTopics: string[];
  topicWeights: Record<string, number>;
  sourceWeights: Record<string, number>;
  diversity: number;
  /** 一覧の上のタブに出すトピック。無ければ既定の5つ（lib/topics.ts）。 */
  categoryTabs?: string[];
}
export type Feedback = Record<string, 'like' | 'dislike'>;
export interface RankedArticle extends Article { score: number; reason: string; }
export interface ReaderState {
  version: 1;
  articles: Article[];
  feeds: Feed[];
  saved: string[];
  read: string[];
  backlogMigratedAt?: string;
  /** 分類の並びと、各分類のフィードの並び。無ければ各フィードの category から作る（lib/folders.ts）。 */
  folders?: { name: string; feedIds: string[] }[];
  feedback: Feedback;
  preferences: Preferences;
  lastUpdated: string | null;
}
