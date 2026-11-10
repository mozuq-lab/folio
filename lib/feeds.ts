import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Article, Feed } from './types.ts';
import { tagTopics } from './topics.ts';

const MAX_BYTES = 2 * 1024 * 1024;
// Upper bound per feed; most feeds publish far fewer items. Fetched articles go to the D1 backlog (folio_articles), not the sync document.
export const MAX_ARTICLES = 200;
type XmlNode = Record<string, unknown>;
type ParsedFeed = { feed: Feed; articles: Article[] };

export type FeedErrorKind = 'network' | 'http' | 'format' | 'timeout';
export type FeedFetchResult =
  | { status: 'ok'; feed: ParsedFeed; etag: string | null; lastModified: string | null }
  | { status: 'not-modified' };

export class FeedError extends Error {
  status: number;
  /** Set where a 502 can be told apart: connection failure vs. an HTTP-level problem. */
  kind?: 'network' | 'http';
  constructor(message: string, status = 422, kind?: 'network' | 'http') {
    super(message);
    this.name = 'FeedError';
    this.status = status;
    this.kind = kind;
  }
}

export function feedErrorKind(error: unknown): FeedErrorKind {
  if (!(error instanceof FeedError)) return 'format';
  if (error.status === 504) return 'timeout';
  if (error.status === 502) return error.kind === 'network' ? 'network' : 'http';
  return 'format';
}

/** Only public HTTPS destinations are accepted, including on every redirect. */
export function isSafeFeedUrl(raw: string): boolean {
  if (typeof raw !== 'string' || /[\u0000-\u0020\u007f]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    // IPv6 literals are intentionally excluded; feed hosts should use a public DNS name.
    if (!host || host.includes(':') || !host.includes('.')) return false;
    if (/(?:^|\.)(localhost|local|internal|lan|home|home\.arpa|localdomain|corp|test|invalid)$/.test(host)) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b, c] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
      if (a === 100 && b >= 64 && b <= 127) return false;
      if (a === 169 && b === 254) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
      if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
      if (a === 203 && b === 0 && c === 113) return false;
      return true;
    }
    return host.split('.').every(part => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(part));
  } catch {
    return false;
  }
}

function record(value: unknown): XmlNode {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : {};
}

function list(value: unknown): unknown[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function rawText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(rawText).join(' ');
  if (value && typeof value === 'object') {
    return Object.entries(value).filter(([key]) => !key.startsWith('@_')).map(([, child]) => rawText(child)).join(' ');
  }
  return '';
}

function decodeEntities(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    if (code[0] !== '#') return entities[code.toLowerCase()] ?? entity;
    const number = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  });
}

function plainText(value: unknown, maxLength = 600): string {
  return decodeEntities(rawText(value))
    .replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function webUrl(value: unknown, base: string, image = false): string | undefined {
  const candidate = typeof value === 'string' ? decodeEntities(value).trim() : '';
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate, base);
    if ((image ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function linkUrl(value: unknown, base: string): string | undefined {
  const links = list(value);
  // Atom commonly provides a self URL before its browser-facing alternate URL.
  const preferred = links.filter(link => {
    const rel = record(link)['@_rel'];
    return !rel || rel === 'alternate';
  });
  for (const link of preferred) {
    const node = record(link);
    const url = webUrl(node['@_href'] ?? node['#text'] ?? link, base);
    if (url) return url;
  }
  return undefined;
}


function hash(value: string): string {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return (result >>> 0).toString(36);
}

function entryImage(entry: XmlNode, base: string): string | undefined {
  const mediaGroup = record(entry['media:group']);
  const candidates = [...list(entry['media:thumbnail']), ...list(mediaGroup['media:thumbnail']), ...list(entry['media:content']), ...list(mediaGroup['media:content'])];
  for (const item of candidates) {
    const node = record(item);
    if (node['@_medium'] && node['@_medium'] !== 'image') continue;
    if (node['@_type'] && !String(node['@_type']).startsWith('image/')) continue;
    const url = webUrl(node['@_url'], base, true);
    if (url) return url;
  }
  for (const item of [...list(entry.enclosure), ...list(entry.link)]) {
    const node = record(item);
    if (!String(node['@_type'] ?? '').startsWith('image/')) continue;
    const url = webUrl(node['@_url'] ?? node['@_href'], base, true);
    if (url) return url;
  }
  const html = decodeEntities(rawText(entry['content:encoded'] ?? entry.content ?? entry.description ?? entry.summary));
  const src = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  return webUrl(src, base, true);
}

export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  if (!xml.trim() || new TextEncoder().encode(xml).byteLength > MAX_BYTES) throw new FeedError('RSSの内容が空、または2MBを超えています。');
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)) throw new FeedError('DOCTYPEや外部entityを含むRSSは読み込めません。');
  if (XMLValidator.validate(xml) !== true) throw new FeedError('RSS / AtomのXML形式を確認してください。');
  let document: XmlNode;
  try {
    document = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, processEntities: false, trimValues: true }).parse(xml) as XmlNode;
  } catch {
    throw new FeedError('RSS / Atomを解析できませんでした。');
  }
  const atom = Object.hasOwn(document, 'feed');
  const rss = record(document.rss);
  const rdf = record(document['rdf:RDF'] ?? document.RDF);
  const channel = record(atom ? document.feed : rss.channel ?? rdf.channel);
  if (!Object.keys(channel).length || (!atom && !Object.hasOwn(rss, 'channel') && !Object.hasOwn(rdf, 'channel'))) {
    throw new FeedError('RSS / AtomフィードのURLを入力してください。');
  }
  const name = plainText(channel.title, 120) || new URL(feedUrl).hostname;
  const website = linkUrl(channel.link, feedUrl) ?? new URL(feedUrl).origin;
  const feed: Feed = {
    id: `feed-${hash(feedUrl)}`, name, url: feedUrl, website,
    category: tagTopics(`${name} ${plainText(channel.description ?? channel.subtitle)}`)[0] ?? '未分類',
    color: ['#DB775C', '#6F8371', '#7685A0', '#A88C59'][Number.parseInt(hash(feedUrl), 36) % 4],
    initial: [...name][0]?.toUpperCase() || 'F',
  };
  const entries = list(atom ? channel.entry : channel.item ?? rdf.item);
  const articles: Article[] = [];
  const seenUrls = new Set<string>();
  for (const value of entries) {
    if (articles.length >= MAX_ARTICLES) break;
    const entry = record(value);
    const guid = rawText(entry.guid);
    const guidIsPermalink = String(record(entry.guid)['@_isPermaLink']).toLowerCase() !== 'false' && /^https?:\/\//i.test(guid);
    const url = linkUrl(entry.link, website) ?? (guidIsPermalink ? webUrl(guid, website) : undefined);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const title = plainText(entry.title, 240) || 'タイトルなし';
    const body = entry['content:encoded'] ?? entry.content ?? entry.description ?? entry.summary;
    const description = plainText(entry.description ?? entry.summary ?? body);
    const fullText = plainText(body, 120_000);
    const timestamp = Date.parse(rawText(entry.pubDate ?? entry.published ?? entry.updated ?? entry['dc:date']));
    const japaneseCharacters = (fullText.match(/[\u3000-\u9fff\uf900-\ufaff]/g) ?? []).length;
    const words = (fullText.match(/[a-z\d]+/gi) ?? []).length;
    articles.push({
      id: `${feed.id}-${hash(rawText(entry.guid ?? entry.id) || url)}`,
      title, description, url, image: entryImage(entry, website),
      sourceId: feed.id, sourceName: feed.name,
      publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString(),
      tags: tagTopics(`${title} ${description} ${plainText(entry.category)}`),
      readingMinutes: Math.max(1, Math.min(60, Math.ceil(japaneseCharacters / 450 + words / 230))),
    });
  }
  return { feed, articles };
}

async function readLimitedBody(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new FeedError('RSSが大きすぎます。2MB以下のフィードを指定してください。', 413);
  }
  if (!response.body) throw new FeedError('RSSの内容が空です。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new FeedError('RSSが大きすぎます。2MB以下のフィードを指定してください。', 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function fetchFeed(feedUrl: string, fetcher: typeof fetch = fetch): Promise<ParsedFeed> {
  const result = await fetchFeedConditional(feedUrl, { fetcher });
  // No validators were sent, so a 304 here would be a misbehaving origin.
  if (result.status !== 'ok') throw new FeedError('配信元からRSSを取得できませんでした（HTTP 304）。', 502, 'http');
  return result.feed;
}

export async function fetchFeedConditional(
  feedUrl: string,
  options: { etag?: string | null; lastModified?: string | null; fetcher?: typeof fetch } = {},
): Promise<FeedFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1' };
  if (options.etag) headers['If-None-Match'] = options.etag;
  if (options.lastModified) headers['If-Modified-Since'] = options.lastModified;
  if (!isSafeFeedUrl(feedUrl)) throw new FeedError('公開されたHTTPSのRSS URLを入力してください。', 400);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let currentUrl = new URL(feedUrl).href;
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!isSafeFeedUrl(currentUrl)) throw new FeedError('安全な公開HTTPS URLへのリダイレクトのみ読み込めます。', 400);
      const response = await fetcher(currentUrl, {
        redirect: 'manual', signal: controller.signal,
        headers,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) throw new FeedError('リダイレクト回数が多すぎるか、転送先が不正です。', 502, 'http');
        try { currentUrl = new URL(location, currentUrl).href; } catch { throw new FeedError('リダイレクト先のURLが不正です。', 502, 'http'); }
        continue;
      }
      if (response.status === 304) {
        await response.body?.cancel();
        return { status: 'not-modified' };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new FeedError(`配信元からRSSを取得できませんでした（HTTP ${response.status}）。`, 502, 'http');
      }
      if (/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new FeedError('HTMLページではなく、RSS / AtomのURLを入力してください。');
      }
      const feed = parseFeed(await readLimitedBody(response), feedUrl);
      return { status: 'ok', feed, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
    }
    throw new FeedError('リダイレクト先を取得できませんでした。', 502, 'http');
  } catch (error) {
    if (error instanceof FeedError) throw error;
    if (controller.signal.aborted) throw new FeedError('RSSの取得がタイムアウトしました。少し待ってお試しください。', 504);
    throw new FeedError('配信元に接続できませんでした。URLを確認してお試しください。', 502, 'network');
  } finally {
    clearTimeout(timeout);
  }
}
