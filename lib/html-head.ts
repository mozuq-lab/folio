/** HTMLページの先頭から読む量。<head> の <link> を拾うのに使う（ファビコンとフィードの発見）。 */
export const HTML_HEAD_BYTES = 256 * 1024;

/** よく使う名前付き文字参照と数値文字参照を戻す。知らない名前はそのまま残す。 */
export function decodeEntities(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    if (code[0] !== '#') return entities[code.toLowerCase()] ?? entity;
    const number = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  });
}

/**
 * index の < から始まるタグの名前を小文字で返す（コメントは "!--"、終了タグは "/head" のように / を付ける）。タグでなければ null。
 * 正規表現を使わず、名前の先頭の数文字だけを見る。ここで知りたい名前はどれも短く、長い名前は途中で切っても取り違えない。
 */
function tagName(html: string, index: number): string | null {
  const start = index + 1;
  if (html.startsWith('!--', start)) return '!--';
  const nameStart = html.charCodeAt(start) === 47 ? start + 1 : start;
  const first = html.charCodeAt(nameStart) | 32;
  if (first < 97 || first > 122) return null;
  let end = nameStart + 1;
  while (end < html.length && end - nameStart < 12) {
    const code = html.charCodeAt(end);
    // 空白・/・<・> で名前が終わる。
    if (code === 9 || code === 10 || code === 12 || code === 13 || code === 32 || code === 47 || code === 60 || code === 62) break;
    end++;
  }
  return html.slice(start, end).toLowerCase();
}
// 引用符の中の > ではタグを閉じない。選択肢の先頭の文字が重ならないので、戻り読みは増えない。
const LINK_TAG = /<link(?:[^>"']|"[^"]*"|'[^']*')*>/iy;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
// 中身を文字として扱う要素。中に書かれた "<link" はタグではない。
const RAW_TEXT_END: Record<string, RegExp> = { script: /<\/script/ig, style: /<\/style/ig, title: /<\/title/ig, textarea: /<\/textarea/ig };

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    // 同じ名前が2回あれば、HTMLの決まりどおり最初のものを使う。
    if (!result.has(name)) result.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return result;
}

/**
 * HTMLの先頭（</head> まで）にある <link> の属性を、出てきた順に返す。属性名は小文字にし、値の文字参照は戻す。
 * コメントと script・style などの中身は飛ばす。DOMは作らず、前から1回なめるだけにする（CPU時間を抑える）。
 * 閉じていないコメント・引用符・script があれば、そこから先はタグとして読まない（HTMLの読み方と同じ）。
 */
export function headLinks(html: string, limit = 100): Map<string, string>[] {
  const links: Map<string, string>[] = [];
  let index = 0;
  while (links.length < limit && (index = html.indexOf('<', index)) !== -1) {
    const name = tagName(html, index);
    if (!name) { index++; continue; }
    if (name === '!--') {
      const end = html.indexOf('-->', index + 4);
      if (end === -1) break;
      index = end + 3;
      continue;
    }
    if (name === '/head') break;
    const rawEnd = Object.hasOwn(RAW_TEXT_END, name) ? RAW_TEXT_END[name] : undefined;
    if (rawEnd) {
      rawEnd.lastIndex = index + name.length + 1;
      const end = rawEnd.exec(html);
      if (!end) break;
      index = end.index + 2;
      continue;
    }
    if (name === 'link') {
      LINK_TAG.lastIndex = index;
      const tag = LINK_TAG.exec(html)?.[0];
      if (!tag) break;
      links.push(attributes(tag.slice(5, -1)));
      index += tag.length;
      continue;
    }
    index++;
  }
  return links;
}
