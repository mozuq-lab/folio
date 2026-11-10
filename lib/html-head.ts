/** HTMLページの先頭から読む量。<head> の <link> を拾うのに使う（ファビコンとフィードの発見）。 */
export const HTML_HEAD_BYTES = 256 * 1024;
/** 読む <link> の上限。hreflang を百数十個並べるサイトがあるので、多めに取る。 */
const MAX_LINKS = 1000;

// よく使う名前付き文字参照。WordPressのフィードの名前（「サイト名 &raquo; フィード」）などに出てくる。
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  raquo: '»', laquo: '«', mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', times: '×',
};
const ENTITY = new RegExp(`&(#x[\\da-f]+|#\\d+|${Object.keys(ENTITIES).join('|')});`, 'gi');

/** よく使う名前付き文字参照と数値文字参照を戻す。知らない名前はそのまま残す。 */
export function decodeEntities(value: string): string {
  return value.replace(ENTITY, (entity, code: string) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? entity;
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
    // 空白・/・> で名前が終わる（< は名前の一部。<link<link …> は link ではない）。
    if (code === 9 || code === 10 || code === 12 || code === 13 || code === 32 || code === 47 || code === 62) break;
    end++;
  }
  return html.slice(start, end).toLowerCase();
}

const isSpace = (code: number) => code === 9 || code === 10 || code === 12 || code === 13 || code === 32;

/**
 * index の < から始まるタグを、ブラウザーと同じ読み方で > まで読み、> の次の位置を返す。閉じていなければ -1。
 * 引用符が値の区切りになるのは = の直後だけ。値の中の > ではタグを閉じず、余分な引用符や、引用符なしの値の中の ' では文字列を始めない。
 * attributes を渡すと属性を入れる（名前は小文字、値の文字参照は戻す。同じ名前が2回あれば、HTMLの決まりどおり最初のものを使う）。
 */
function readTag(html: string, index: number, attributes?: Map<string, string>): number {
  const length = html.length;
  // 終了タグ（</x …>）の名前は / の次から。
  let i = index + (html.charCodeAt(index + 1) === 47 ? 2 : 1);
  while (i < length) { const code = html.charCodeAt(i); if (isSpace(code) || code === 47 || code === 62) break; i++; }
  for (;;) {
    while (i < length) { const code = html.charCodeAt(i); if (!isSpace(code) && code !== 47) break; i++; }
    if (i >= length) return -1;
    if (html.charCodeAt(i) === 62) return i + 1;
    const nameStart = i++;
    while (i < length) { const code = html.charCodeAt(i); if (isSpace(code) || code === 47 || code === 61 || code === 62) break; i++; }
    const nameEnd = i;
    while (i < length && isSpace(html.charCodeAt(i))) i++;
    let value = '';
    if (i < length && html.charCodeAt(i) === 61) {
      i++;
      while (i < length && isSpace(html.charCodeAt(i))) i++;
      if (i >= length) return -1;
      const quote = html.charCodeAt(i);
      if (quote === 34 || quote === 39) {
        const end = html.indexOf(quote === 34 ? '"' : "'", i + 1);
        if (end === -1) return -1;
        if (attributes) value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < length) { const code = html.charCodeAt(i); if (isSpace(code) || code === 62) break; i++; }
        if (attributes) value = html.slice(valueStart, i);
      }
    }
    if (attributes) {
      const name = html.slice(nameStart, nameEnd).toLowerCase();
      if (!attributes.has(name)) attributes.set(name, decodeEntities(value));
    }
  }
}

// 中身を文字として扱う要素。中に書かれた "<link" はタグではない。終了タグは、名前の次が空白・/・> のときだけ（"</scripts>" や '</script' + '>' では閉じない）。
const RAW_TEXT_END: Record<string, RegExp> = { script: /<\/script(?=[\t\n\f\r \/>])/ig, style: /<\/style(?=[\t\n\f\r \/>])/ig, title: /<\/title(?=[\t\n\f\r \/>])/ig, textarea: /<\/textarea(?=[\t\n\f\r \/>])/ig };

/**
 * HTMLの先頭（</head> まで）にある <link> の属性を、出てきた順に返す。属性名は小文字にし、値の文字参照は戻す。
 * どのタグも > まで読み飛ばすので、ほかのタグの属性値の中に書かれた "<link" や "</head>" はタグとして読まない。
 * コメントと script・style などの中身も飛ばす。DOMは作らず、前から1回なめるだけにする（CPU時間を抑える）。
 * 閉じていないコメント・引用符・script があれば、そこから先はタグとして読まない（HTMLの読み方と同じ）。
 */
export function headLinks(html: string, limit = MAX_LINKS): Map<string, string>[] {
  const links: Map<string, string>[] = [];
  let index = 0;
  while (links.length < limit && (index = html.indexOf('<', index)) !== -1) {
    const name = tagName(html, index);
    if (name === null) {
      // <!DOCTYPE …>・<?…>・名前の無い終了タグ（</ …>）は、最初の > までを読み飛ばす。それ以外の < は文字。
      const next = html.charCodeAt(index + 1);
      if (next !== 33 && next !== 63 && !(next === 47 && index + 2 < html.length)) { index++; continue; }
      const end = html.indexOf('>', index + 2);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (name === '!--') {
      // <!--> と <!---> は空のコメントなので、<!-- の途中からも --> を探す。
      const end = html.indexOf('-->', index + 2);
      if (end === -1) break;
      index = end + 3;
      continue;
    }
    if (name === '/head') break;
    const attributes = name === 'link' ? new Map<string, string>() : undefined;
    const end = readTag(html, index, attributes);
    if (end === -1) break;
    if (attributes) links.push(attributes);
    index = end;
    const rawEnd = Object.hasOwn(RAW_TEXT_END, name) ? RAW_TEXT_END[name] : undefined;
    if (rawEnd) {
      rawEnd.lastIndex = index;
      const close = rawEnd.exec(html);
      if (!close) break;
      index = close.index;
    }
  }
  return links;
}
