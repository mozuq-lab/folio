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
  fragment: string;
  title: string;
  titleTokens: Set<string>;
  /** 概要のtokenは見出しが近い記事どうしでだけ使うので、必要になってから作る（descriptionTokensOf）。 */
  description: string;
  descriptionTokens: Set<string> | null;
  entities: Set<string>;
  numbers: string;
  published: number;
  japanese: boolean;
  text: string;
}
/** 公開日時のある記事は公開日時の昇順に並べ、sameStoryの7日の条件で範囲を絞って引けるようにする。値は記事の位置。 */
interface Posting {
  dated: number[];
  times: number[];
  undated: number[];
}
interface ImportanceIndex {
  articles: Article[];
  byId: Map<string, number[]>;
  byUrl: Map<string, number[]>;
  byTitle: Map<string, number[]>;
  /** 見出しtokenの番号と、番号ごとの出現記事数。 */
  tokenIds: Map<string, number>;
  frequency: Int32Array;
  /** 記事の位置ごとの見出しtoken番号と、prefix（storyPrefixを参照）。 */
  titleTokens: Int32Array[];
  prefixes: Int32Array[];
  /** prefix tokenの番号から記事の位置を引く。 */
  byPrefix: (Posting | undefined)[];
  /** candidatePositionsの作業領域。呼び出しごとにprobeを進め、印の付け直しを省く。共有するのでcandidatePositionsは入れ子で呼ばない。 */
  tokenMarks: Int32Array;
  articleMarks: Int32Array;
  probe: number;
  /** 記事の位置ごとの、同じニュースとみなす記事の位置（storyMatches）。 */
  matches: number[][] | null;
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

function fragmentOf(value: string): string {
  try { return new URL(value).hash; } catch { return ''; }
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
    order: parsedOrder++, url: canonicalUrl(article.url), fragment: fragmentOf(article.url), title,
    titleTokens: new Set(tokens(title)), description: article.description, descriptionTokens: null,
    entities: new Set((plain(article.title).normalize('NFKC').match(/\b[A-Z][A-Za-z\d]+\b/g) ?? []).map(normalize).filter(term => !STOP_WORDS.has(term))),
    numbers: [...title.matchAll(/\d+(?:\.\d+)?/g)].map(match => match[0]).join(','),
    published: Number.isFinite(published) ? published : 0,
    japanese: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title),
    text: normalize([article.title, article.description, article.tags.join(' ')].join(' ')),
  };
  parsedArticles.set(article, parsed);
  return parsed;
}

function descriptionTokensOf(parsed: ParsedArticle): Set<string> {
  return parsed.descriptionTokens ??= new Set(tokens(parsed.description));
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  if (left.size > right.size) return intersectionSize(right, left);
  let count = 0;
  for (const token of left) if (right.has(token)) count++;
  return count;
}

function sameStory(a: Article, b: Article): boolean {
  const left = parsedArticle(a), right = parsedArticle(b);
  // 同じフィードが同じページ内の別の項目（#1・#2…）を指す場合は、URLだけでは同じニュースとしない。
  if (left.url && left.url === right.url && (a.sourceId !== b.sourceId || left.fragment === right.fragment)) return true;
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
    const leftDescription = descriptionTokensOf(left), rightDescription = descriptionTokensOf(right);
    const descriptionShared = intersectionSize(leftDescription, rightDescription);
    const descriptionUnion = leftDescription.size + rightDescription.size - descriptionShared;
    matches = descriptionShared >= 8 && descriptionShared / Math.max(1, descriptionUnion) >= 0.8;
  }
  let pairs = storyPairs.get(first);
  if (!pairs) { pairs = new WeakMap(); storyPairs.set(first, pairs); }
  pairs.set(second, matches);
  return matches;
}

/**
 * URL・見出しの完全一致以外でsameStoryが一致にする条件は、どれも「見出しtokenが4個以上共通、かつ共通数が和集合の
 * 半分以上」を含む。和集合は各記事のtoken数以上なので、共通数は t = max(4, ⌈token数 / 2⌉) 以上になる。
 * tokenを出現記事数の少ない順に並べると最初の共通tokenは token数 - t + 1 番目以内にあるので、この先頭部分（prefix）
 * どうしが1つも重ならない2記事は一致しない（prefix filtering）。
 * 日本語の2文字tokenは多くの記事に現れるため、全tokenで候補を数えると件数の2乗に近くなる。
 */
function storyPrefix(index: ImportanceIndex, parsed: ParsedArticle, ids?: Int32Array): Int32Array {
  const size = parsed.titleTokens.size;
  const length = size - Math.max(4, Math.ceil(size / 2)) + 1;
  if (length <= 0) return new Int32Array(0);
  // 並びは（出現記事数, token番号）の昇順。集合に無いtokenは出現0件として先頭に来るが、どの記事とも共有しないので引かない。
  let missing = 0;
  let known = ids;
  if (!known) {
    const found: number[] = [];
    for (const token of parsed.titleTokens) {
      const id = index.tokenIds.get(token);
      if (id === undefined) missing++; else found.push(id);
    }
    known = Int32Array.from(found);
  }
  const { frequency } = index;
  return Int32Array.from(known).sort((a, b) => frequency[a] - frequency[b] || a - b).subarray(0, Math.max(0, length - missing));
}

function importanceIndex(articles: Article[]): ImportanceIndex {
  const cached = importanceIndexes.get(articles);
  if (cached) return cached;
  const list = [...articles];
  const tokenIds = new Map<string, number>();
  const counts: number[] = [];
  const index: ImportanceIndex = {
    articles: list, byId: new Map(), byUrl: new Map(), byTitle: new Map(), tokenIds, frequency: new Int32Array(0), titleTokens: [], prefixes: [], byPrefix: [],
    tokenMarks: new Int32Array(0), articleMarks: new Int32Array(list.length), probe: 0, matches: null, sources: new WeakMap(),
  };
  const add = <T>(map: Map<string, T[]>, key: string, value: T) => {
    let values = map.get(key);
    if (!values) { values = []; map.set(key, values); }
    values.push(value);
  };
  list.forEach((article, position) => {
    const parsed = parsedArticle(article);
    add(index.byId, article.id, position);
    if (parsed.url) add(index.byUrl, parsed.url, position);
    if (parsed.title) add(index.byTitle, parsed.title, position);
    const ids = new Int32Array(parsed.titleTokens.size);
    let i = 0;
    for (const token of parsed.titleTokens) {
      let id = tokenIds.get(token);
      if (id === undefined) { id = tokenIds.size; tokenIds.set(token, id); counts.push(0); }
      ids[i++] = id;
      counts[id]++;
    }
    index.titleTokens.push(ids);
  });
  index.frequency = Int32Array.from(counts);
  index.tokenMarks = new Int32Array(tokenIds.size);
  list.forEach((article, position) => {
    const parsed = parsedArticle(article);
    const prefix = storyPrefix(index, parsed, index.titleTokens[position]);
    index.prefixes.push(prefix);
    for (const id of prefix) {
      const posting = index.byPrefix[id] ??= { dated: [], times: [], undated: [] };
      if (parsed.published) posting.dated.push(position); else posting.undated.push(position);
    }
  });
  const published = list.map(article => parsedArticle(article).published);
  for (const posting of index.byPrefix) {
    if (!posting) continue;
    posting.dated.sort((a, b) => published[a] - published[b]);
    posting.times = posting.dated.map(position => published[position]);
  }
  importanceIndexes.set(articles, index);
  return index;
}

/**
 * sameStoryが一致にしうる記事の位置。ここに無い記事とは必ず一致しない。
 * prefixで引いた記事は、見出しtokenの共通数を数えて「4個以上かつ和集合の半分以上」（3×共通数 ≧ 両者のtoken数の和）を
 * 満たすものだけを残す。URL・見出しが一致する記事はそのまま含める。
 * forwardでは、集合内の記事（位置self）について、各組を片方からだけ引く：URL・見出しの一致は位置が後の記事、
 * prefixは公開日時が後（同時刻なら位置が後）の記事。公開日時の無い記事との組は、公開日時の無い側から引く。
 */
function candidatePositions(index: ImportanceIndex, parsed: ParsedArticle, prefix: Int32Array, self: number, forward: boolean): number[] {
  const { articleMarks, tokenMarks, titleTokens } = index;
  const probe = ++index.probe;
  const result: number[] = [];
  const take = (position: number) => {
    if (articleMarks[position] === probe || (forward && position <= self)) return;
    articleMarks[position] = probe;
    result.push(position);
  };
  if (parsed.url) for (const position of index.byUrl.get(parsed.url) ?? []) take(position);
  for (const position of index.byTitle.get(parsed.title) ?? []) take(position);
  for (const token of parsed.titleTokens) {
    const id = index.tokenIds.get(token);
    if (id !== undefined) tokenMarks[id] = probe;
  }
  const size = parsed.titleTokens.size;
  const consider = (position: number) => {
    if (articleMarks[position] === probe) return;
    articleMarks[position] = probe;
    const tokens = titleTokens[position];
    const needed = Math.max(4, Math.ceil((size + tokens.length) / 3));
    if (needed > tokens.length || needed > size) return;
    let shared = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (tokenMarks[tokens[i]] === probe) shared++;
      else if (shared + tokens.length - i - 1 < needed) return;
    }
    result.push(position);
  };
  const published = parsed.published;
  for (const id of prefix) {
    const posting = index.byPrefix[id];
    if (!posting) continue;
    const { times, dated, undated } = posting;
    if (!published) {
      for (const position of undated) if (!forward || position > self) consider(position);
      for (const position of dated) consider(position);
      continue;
    }
    if (!forward) for (const position of undated) consider(position);
    // sameStoryは公開日時が7日より離れた記事を一致にしない（URLの一致は上で別に引いている）。
    const from = forward ? published : published - 7 * DAY, to = published + 7 * DAY;
    let low = 0, high = times.length;
    while (low < high) { const middle = (low + high) >> 1; if (times[middle] < from) low = middle + 1; else high = middle; }
    for (let i = low; i < times.length && times[i] <= to; i++) {
      if (forward && times[i] === published && dated[i] <= self) continue;
      consider(dated[i]);
    }
  }
  return result;
}

/** 記事集合の中で、記事の位置ごとに同じニュースとみなす記事の位置。各組のsameStoryは1回だけ確かめる。 */
function storyMatches(index: ImportanceIndex): number[][] {
  if (index.matches) return index.matches;
  const { articles } = index;
  const matches = articles.map((): number[] => []);
  articles.forEach((article, position) => {
    for (const other of candidatePositions(index, parsedArticle(article), index.prefixes[position], position, true)) {
      if (!sameStory(article, articles[other])) continue;
      // URLの一致とprefixで同じ組を両側から1回ずつ引くことがあるが、使う側（sourceCount・clusterStories）はSetで重複を除く。
      matches[position].push(other);
      matches[other].push(position);
    }
  });
  index.matches = matches;
  return matches;
}

/** rankArticles等が返すコピーも、集約に使うfieldが同じなら集合内の元記事として扱う。 */
function originalPosition(index: ImportanceIndex, article: Article): number | undefined {
  return index.byId.get(article.id)?.find(position => {
    const candidate = index.articles[position];
    return candidate === article || (
      candidate.url === article.url && candidate.title === article.title && candidate.description === article.description &&
      candidate.publishedAt === article.publishedAt && candidate.sourceId === article.sourceId
    );
  });
}

function sourceCount(index: ImportanceIndex, original: Article, position: number | undefined): number {
  const cached = index.sources.get(original);
  if (cached !== undefined) return cached;
  const sources = new Set([original.sourceId]);
  if (position !== undefined) {
    for (const other of storyMatches(index)[position]) sources.add(index.articles[other].sourceId);
  } else {
    const parsed = parsedArticle(original);
    for (const other of candidatePositions(index, parsed, storyPrefix(index, parsed), -1, false)) {
      if (sameStory(original, index.articles[other])) sources.add(index.articles[other].sourceId);
    }
  }
  index.sources.set(original, sources.size);
  return sources.size;
}

export function scoreImportance(article: Article, articles: Article[], now = Date.now()): { score: number; reason: string } {
  const clock = Number.isFinite(now) ? now : Date.now();
  const index = importanceIndex(articles);
  const position = originalPosition(index, article);
  const original = position === undefined ? article : index.articles[position];
  // 公開日時と本文の語句は、タグも同じなら元記事の解析結果を使う（コピーを解析し直さない）。
  const source = original === article || original.tags.length !== article.tags.length || original.tags.some((tag, i) => tag !== article.tags[i]) ? article : original;
  const published = timestamp(source);
  const age = published ? Math.max(0, clock - published) / DAY : Infinity;
  const freshness = age <= 1 ? 24 : age <= 3 ? 16 : age <= 7 ? 8 : 0;
  const sources = sourceCount(index, original, position);
  const coverage = Math.min(36, Math.max(0, sources - 1) * 12);
  const impact = /\b(?:critical|vulnerability|security|emergency|earthquake|outage|recall|legislation|election)\b|脆弱性|緊急|災害|地震|法改正|大規模障害|情報漏[洩えい]|リコール|選挙/.test(textOf(source)) ? 25 : 0;
  const score = Math.min(99, 10 + freshness + coverage + impact);
  const reasons = [`${sources}出典での掲載`];
  reasons.push(!published ? '公開日時は不明' : freshness ? '最近の公開' : '公開から時間が経過');
  if (impact) reasons.push('公共への影響・重大更新に関する語句あり');
  return { score, reason: `${reasons.join('。')}。字句と掲載状況による推定です。` };
}

/** 公開日時が直近days日以内の記事。公開日時が読めない記事は含めない。 */
export function recentArticles(articles: Article[], now: Date, days = 7): Article[] {
  const since = now.getTime() - days * DAY;
  return articles.filter(article => {
    const published = Date.parse(article.publishedAt);
    return Number.isFinite(published) && published >= since;
  });
}

export function clusterStories(articles: Article[], readIds: string[], now = Date.now()): StoryCluster[] {
  const matches = storyMatches(importanceIndex(articles));
  const groups: Article[][] = [];
  const groupOf = new Int32Array(articles.length).fill(-1);
  const seen = new Set<string>();
  articles.forEach((article, position) => {
    if (seen.has(article.id)) return;
    seen.add(article.id);
    // 全メンバーとの一致を要求し、類似性の連鎖による誤結合を避ける。
    // 一致する記事を含まないまとまりは全員とは一致しないので、一致する記事を含むまとまりだけを作った順に確かめる。
    const indexes = new Set<number>();
    for (const other of matches[position]) if (groupOf[other] >= 0) indexes.add(groupOf[other]);
    const found = [...indexes].sort((a, b) => a - b).find(i => groups[i].every(other => sameStory(article, other)));
    if (found !== undefined) {
      groups[found].push(article);
      groupOf[position] = found;
    } else {
      groupOf[position] = groups.length;
      groups.push([article]);
    }
  });
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

const termMatchers = new Map<string, (text: string) => boolean>();
function termMatcher(term: string): (text: string) => boolean {
  const cached = termMatchers.get(term);
  if (cached) return cached;
  const normalized = normalize(term);
  let matcher: (text: string) => boolean;
  if (!normalized) matcher = () => false;
  // 英単語の部分一致（AIがdailyに一致する等）を避ける。
  else if (/^[a-z\d ]+$/.test(normalized)) {
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`);
    matcher = text => pattern.test(text);
  } else matcher = text => text.includes(normalized);
  // 語は利用者の設定から来るので少ないが、念のため上限を置く。
  if (termMatchers.size >= 1000) termMatchers.clear();
  termMatchers.set(term, matcher);
  return matcher;
}
function includesTerm(text: string, term: string): boolean {
  return termMatcher(term)(text);
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
  let newest = 0;
  for (const article of pool) newest = Math.max(newest, timestamp(article));
  const interests = preferences.interests.map(normalize);
  // 選ぶたびに変わるのは媒体ごとの減点だけなので、それ以外は記事ごとに一度だけ計算する。
  const scored = pool.map(article => {
    const outside = !preferences.interests.some(term => includesTerm(textOf(article), term));
    const novelTags = article.tags.filter(tag => !interests.includes(normalize(tag))).length;
    const age = timestamp(article) ? Math.max(0, newest - timestamp(article)) / DAY : Infinity;
    return { article, base: (outside ? 20 : 0) + Math.min(4, novelTags * 2) + Math.max(0, 4 - age) };
  });
  const chosen: Article[] = [];
  const sourceCounts = new Map<string, number>();
  const value = ({ article, base }: (typeof scored)[number]): number => base - (sourceCounts.get(article.sourceId) ?? 0) * 8;
  while (scored.length && chosen.length < limit) {
    let best = 0, bestValue = value(scored[0]);
    for (let i = 1; i < scored.length; i++) {
      const current = value(scored[i]);
      if (current > bestValue) { best = i; bestValue = current; }
    }
    const [{ article }] = scored.splice(best, 1);
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
    .map(article => ({ article, score: scoreNaturalPreference(article, profile) }))
    .sort((a, b) => b.score - a.score)
    .map(({ article }) => article);
}
