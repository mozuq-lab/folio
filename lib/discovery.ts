import type { Article, Feedback, Preferences } from './types.ts';
import type { ArticleNote, DigestResult, NaturalProfile } from './intelligence-types.ts';

export interface StoryCluster {
  id: string;
  title: string;
  articles: Article[];
  unreadArticles: Article[];
  readArticles: Article[];
  latestAt: string;
  importance: number;
  /** 未読記事の見出し・概要の抜粋。意味上の新事実を判定したものではない。 */
  newCoverage: string[];
}

const DAY = 86_400_000;
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'from', 'at', 'by', 'as', 'its', 'this', 'that']);
const normalize = (text: string): string => text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const plain = (text: string): string => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const timestamp = (article: Article): number => parsedArticle(article).published;
const textOf = (article: Article): string => parsedArticle(article).text;

interface ParsedArticle {
  order: number;
  url: string | null;
  title: string;
  titleTokens: Set<string>;
  descriptionTokens: Set<string>;
  entities: Set<string>;
  numbers: string;
  published: number;
  japanese: boolean;
  text: string;
}
interface ImportanceIndex {
  byId: Map<string, Article[]>;
  byUrl: Map<string, Article[]>;
  byTitle: Map<string, Article[]>;
  byToken: Map<string, Article[]>;
  sources: WeakMap<Article, number>;
}

// 入力のArticleと記事配列はimmutableとして扱う。編集時には新object/新配列を渡す。
// WeakMapなので、破棄された記事集合をcacheが保持し続けることはない。
const parsedArticles = new WeakMap<Article, ParsedArticle>();
const importanceIndexes = new WeakMap<Article[], ImportanceIndex>();
const storyPairs = new WeakMap<ParsedArticle, WeakMap<ParsedArticle, boolean>>();
let parsedOrder = 0;

/** 英単語と日本語の文字bigram。外部モデルなしの字句検索に限定する。 */
function tokens(text: string): string[] {
  const result: string[] = [];
  for (const part of normalize(plain(text)).match(/[a-z\d]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? []) {
    if (/^[a-z\d]+$/.test(part)) {
      if (!STOP_WORDS.has(part)) result.push(part);
    } else if (part.length === 1) {
      result.push(part);
    } else {
      for (let i = 0; i < part.length - 1; i++) result.push(part.slice(i, i + 2));
    }
  }
  return result;
}

function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

function parsedArticle(article: Article): ParsedArticle {
  const cached = parsedArticles.get(article);
  if (cached) return cached;
  const title = normalize(plain(article.title));
  const published = Date.parse(article.publishedAt);
  const parsed: ParsedArticle = {
    order: parsedOrder++, url: canonicalUrl(article.url), title,
    titleTokens: new Set(tokens(title)), descriptionTokens: new Set(tokens(article.description)),
    entities: new Set((plain(article.title).normalize('NFKC').match(/\b[A-Z][A-Za-z\d]+\b/g) ?? []).map(normalize).filter(term => !STOP_WORDS.has(term))),
    numbers: [...title.matchAll(/\d+(?:\.\d+)?/g)].map(match => match[0]).join(','),
    published: Number.isFinite(published) ? published : 0,
    japanese: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title),
    text: normalize([article.title, article.description, article.tags.join(' ')].join(' ')),
  };
  parsedArticles.set(article, parsed);
  return parsed;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  if (left.size > right.size) return intersectionSize(right, left);
  let count = 0;
  for (const token of left) if (right.has(token)) count++;
  return count;
}

function sameStory(a: Article, b: Article): boolean {
  const left = parsedArticle(a), right = parsedArticle(b);
  if (left.url && left.url === right.url) return true;
  if (left.published && right.published && Math.abs(left.published - right.published) > 7 * DAY) return false;
  if (!left.title || !right.title) return false;
  if (left.title === right.title) return true;
  // 製品世代・金額・日時などが異なる記事を、似た見出しだけでまとめない。
  if (left.numbers && right.numbers && left.numbers !== right.numbers) return false;
  // 大文字から始まる固有名詞候補が双方で異なる場合も保守的に分離する。
  const sharedEntities = intersectionSize(left.entities, right.entities);
  if (sharedEntities < left.entities.size && sharedEntities < right.entities.size) return false;
  const first = left.order < right.order ? left : right;
  const second = left.order < right.order ? right : left;
  const cached = storyPairs.get(first)?.get(second);
  if (cached !== undefined) return cached;
  const shared = intersectionSize(left.titleTokens, right.titleTokens);
  const union = left.titleTokens.size + right.titleTokens.size - shared;
  // 共通のtopicタグやpublisherだけでは結合しない。見出しの強い一致が必要。
  const minimumShared = left.japanese || right.japanese ? 8 : 5;
  let matches = shared >= minimumShared && union > 0 && shared / union >= 0.7;
  // 見出しが少し異なる場合も、概要の強い一致があって初めて結合する。
  if (!matches && shared >= 4 && shared / Math.max(1, union) >= 0.5) {
    const descriptionShared = intersectionSize(left.descriptionTokens, right.descriptionTokens);
    const descriptionUnion = left.descriptionTokens.size + right.descriptionTokens.size - descriptionShared;
    matches = descriptionShared >= 8 && descriptionShared / Math.max(1, descriptionUnion) >= 0.8;
  }
  let pairs = storyPairs.get(first);
  if (!pairs) { pairs = new WeakMap(); storyPairs.set(first, pairs); }
  pairs.set(second, matches);
  return matches;
}

function importanceIndex(articles: Article[]): ImportanceIndex {
  const cached = importanceIndexes.get(articles);
  if (cached) return cached;
  const index: ImportanceIndex = { byId: new Map(), byUrl: new Map(), byTitle: new Map(), byToken: new Map(), sources: new WeakMap() };
  const add = (map: Map<string, Article[]>, key: string, article: Article) => {
    let values = map.get(key);
    if (!values) { values = []; map.set(key, values); }
    values.push(article);
  };
  for (const article of articles) {
    const parsed = parsedArticle(article);
    add(index.byId, article.id, article);
    if (parsed.url) add(index.byUrl, parsed.url, article);
    if (parsed.title) add(index.byTitle, parsed.title, article);
    for (const token of parsed.titleTokens) add(index.byToken, token, article);
  }
  importanceIndexes.set(articles, index);
  return index;
}

function sourceCount(article: Article, articles: Article[]): number {
  const index = importanceIndex(articles);
  // rankArticles等が返すコピーも、集約に使うfieldが同じなら元記事の集計を利用する。
  const original = index.byId.get(article.id)?.find(candidate => candidate === article || (
    candidate.url === article.url && candidate.title === article.title && candidate.description === article.description &&
    candidate.publishedAt === article.publishedAt && candidate.sourceId === article.sourceId
  )) ?? article;
  const cached = index.sources.get(original);
  if (cached !== undefined) return cached;
  const parsed = parsedArticle(original);
  const candidates = new Set<Article>();
  for (const candidate of index.byUrl.get(parsed.url ?? '') ?? []) candidates.add(candidate);
  for (const candidate of index.byTitle.get(parsed.title) ?? []) candidates.add(candidate);
  // URL/完全一致以外の既存条件は見出しtokenが4個以上共通の場合だけ。
  // inverted indexでその必要条件を満たさない記事の比較を省く。
  if (candidates.size < articles.length) {
    const overlaps = new Map<Article, number>();
    for (const token of parsed.titleTokens) {
      for (const candidate of index.byToken.get(token) ?? []) {
        const count = (overlaps.get(candidate) ?? 0) + 1;
        overlaps.set(candidate, count);
        if (count === 4) candidates.add(candidate);
      }
    }
  }
  const sources = new Set([original.sourceId]);
  for (const candidate of candidates) if (sameStory(original, candidate)) sources.add(candidate.sourceId);
  index.sources.set(original, sources.size);
  return sources.size;
}

export function scoreImportance(article: Article, articles: Article[], now = Date.now()): { score: number; reason: string } {
  const clock = Number.isFinite(now) ? now : Date.now();
  const published = timestamp(article);
  const age = published ? Math.max(0, clock - published) / DAY : Infinity;
  const freshness = age <= 1 ? 24 : age <= 3 ? 16 : age <= 7 ? 8 : 0;
  const sources = sourceCount(article, articles);
  const coverage = Math.min(36, Math.max(0, sources - 1) * 12);
  const impact = /\b(?:critical|vulnerability|security|emergency|earthquake|outage|recall|legislation|election)\b|脆弱性|緊急|災害|地震|法改正|大規模障害|情報漏[洩えい]|リコール|選挙/.test(textOf(article)) ? 25 : 0;
  const score = Math.min(99, 10 + freshness + coverage + impact);
  const reasons = [`${sources}出典での掲載`];
  reasons.push(!published ? '公開日時は不明' : freshness ? '最近の公開' : '公開から時間が経過');
  if (impact) reasons.push('公共への影響・重大更新に関する語句あり');
  return { score, reason: `${reasons.join('。')}。字句と掲載状況による推定です。` };
}

export function clusterStories(articles: Article[], readIds: string[], now = Date.now()): StoryCluster[] {
  const groups: Article[][] = [];
  const seen = new Set<string>();
  for (const article of articles) {
    if (seen.has(article.id)) continue;
    seen.add(article.id);
    // 全メンバーとの一致を要求し、類似性の連鎖による誤結合を避ける。
    const group = groups.find(group => group.every(other => sameStory(article, other)));
    if (group) group.push(article); else groups.push([article]);
  }
  const read = new Set(readIds);
  return groups.map(group => {
    const sorted = [...group].sort((a, b) => timestamp(b) - timestamp(a));
    const unreadArticles = sorted.filter(a => !read.has(a.id));
    const readArticles = sorted.filter(a => read.has(a.id));
    const latest = timestamp(sorted[0]);
    return {
      id: [...group].map(a => a.id).sort()[0], title: sorted[0].title, articles: sorted,
      unreadArticles, readArticles, latestAt: latest ? new Date(latest).toISOString() : '',
      importance: Math.max(...group.map(a => scoreImportance(a, articles, now).score)),
      newCoverage: readArticles.length ? unreadArticles.map(a => [plain(a.title), plain(a.description).slice(0, 180)].filter(Boolean).join(' — ')) : [],
    };
  }).sort((a, b) => (Date.parse(b.latestAt) || 0) - (Date.parse(a.latestAt) || 0));
}

function includesTerm(text: string, term: string): boolean {
  const normalized = normalize(term);
  if (!normalized) return false;
  // 英単語の部分一致（AIがdailyに一致する等）を避ける。
  if (/^[a-z\d ]+$/.test(normalized)) {
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(text);
  }
  return text.includes(normalized);
}

export function selectExploration(articles: Article[], preferences: Preferences, feedback: Feedback, count: number, excludedIds: string[] = []): Article[] {
  const limit = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (!limit) return [];
  const excluded = new Set(excludedIds);
  const seen = new Set<string>();
  const pool = articles.filter(article => {
    if (seen.has(article.id)) return false;
    seen.add(article.id);
    return !excluded.has(article.id) && !article.isSample && feedback[article.id] !== 'dislike' && !preferences.mutedTopics.some(term => includesTerm(textOf(article), term));
  });
  const newest = Math.max(0, ...pool.map(timestamp));
  const chosen: Article[] = [];
  const sourceCounts = new Map<string, number>();
  while (pool.length && chosen.length < limit) {
    const value = (article: Article): number => {
      const outside = !preferences.interests.some(term => includesTerm(textOf(article), term));
      const novelTags = article.tags.filter(tag => !preferences.interests.some(term => normalize(term) === normalize(tag))).length;
      const age = timestamp(article) ? Math.max(0, newest - timestamp(article)) / DAY : Infinity;
      return (outside ? 20 : 0) + Math.min(4, novelTags * 2) + Math.max(0, 4 - age) - (sourceCounts.get(article.sourceId) ?? 0) * 8;
    };
    let best = 0;
    for (let i = 1; i < pool.length; i++) if (value(pool[i]) > value(pool[best])) best = i;
    const [article] = pool.splice(best, 1);
    chosen.push(article);
    sourceCounts.set(article.sourceId, (sourceCounts.get(article.sourceId) ?? 0) + 1);
  }
  return chosen;
}

export function buildReadingPlan(articles: Article[], budgetMinutes: number, readIds: string[] = []): DigestResult {
  const budget = Number.isFinite(budgetMinutes) ? Math.max(0, Math.min(30, Math.floor(budgetMinutes))) : 0;
  const result: DigestResult = { title: `${budget}分の読書プラン`, overview: '記事の概要を抜粋した読書プランです。所要時間は元記事の目安です。', items: [], totalMinutes: 0, generatedAt: new Date().toISOString(), mode: 'extractive' };
  const excluded = new Set(readIds);
  for (const article of articles) {
    if (excluded.has(article.id)) continue;
    excluded.add(article.id);
    const minutes = Number.isFinite(article.readingMinutes) ? Math.max(1, Math.ceil(article.readingMinutes)) : 1;
    if (result.totalMinutes + minutes > budget) continue;
    result.items.push({ articleId: article.id, summary: plain(article.description).slice(0, 400) || plain(article.title), takeaway: `${article.sourceName}の記事概要から抜粋`, minutes });
    result.totalMinutes += minutes;
  }
  return result;
}

export function searchLibrary(articles: Article[], notes: ArticleNote[], query: string, limit = 30): Article[] {
  const terms = [...new Set(tokens(query))];
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 30;
  if (!terms.length || !max || !articles.length) return [];
  const noteText = new Map<string, string[]>();
  for (const note of notes) noteText.set(note.articleId, [...(noteText.get(note.articleId) ?? []), note.body, note.quote]);
  const documents = articles.map(article => {
    // 見出しを重くする。本文とメモも同じ記事の検索対象に含む。
    const words = tokens([article.title, article.title, article.description, article.content ?? '', article.tags.join(' '), ...(noteText.get(article.id) ?? [])].join(' '));
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { article, words, counts };
  });
  const averageLength = Math.max(1, documents.reduce((sum, doc) => sum + doc.words.length, 0) / documents.length);
  const frequencies = new Map(terms.map(term => [term, documents.filter(doc => doc.counts.has(term)).length]));
  return documents.map(doc => {
    let score = 0;
    for (const term of terms) {
      const frequency = doc.counts.get(term) ?? 0;
      if (!frequency) continue;
      const documentFrequency = frequencies.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
      score += idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * doc.words.length / averageLength));
    }
    return { article: doc.article, score };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, max).map(hit => hit.article);
}

export function scoreNaturalPreference(article: Article, profile: NaturalProfile | null): number {
  if (!profile) return 0;
  const text = textOf(article);
  let score = Math.min(30, profile.boostTerms.filter(term => includesTerm(text, term)).length * 10);
  const depthPatterns = {
    introductory: /\b(?:introduction|beginner|basics|explained)\b|入門|初心者|基礎|やさしく/,
    practical: /\b(?:tutorial|guide|practical|implementation|hands.on)\b|実践|実装|使い方|手順/,
    advanced: /\b(?:advanced|internals|deep.dive|research|benchmark)\b|詳細解説|内部構造|論文|高度|専門/,
  };
  if (profile.preferredDepth !== 'any' && depthPatterns[profile.preferredDepth].test(text)) score += 8;
  return score;
}

export function applyNaturalProfile(articles: Article[], profile: NaturalProfile | null): Article[] {
  if (!profile) return [...articles];
  return articles.filter(article => !profile.muteTerms.some(term => includesTerm(textOf(article), term)))
    .sort((a, b) => scoreNaturalPreference(b, profile) - scoreNaturalPreference(a, profile));
}
