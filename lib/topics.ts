/** 興味のあるトピックの候補。記事のタグもこの中から付ける。 */
export const TOPICS = [
  'テクノロジー',
  'AI・機械学習',
  '開発',
  'セキュリティ',
  'デザイン',
  'プロダクト',
  'ビジネス',
  'スタートアップ',
  '投資・マネー',
  'サイエンス',
  'カルチャー',
  'ゲーム',
  '暮らし',
];

/** 一覧の上のタブに出すトピックを選んでいないときの既定（これまでの表示と同じ）。 */
export const DEFAULT_CATEGORY_TABS = ['テクノロジー', 'デザイン', 'ビジネス', 'サイエンス', '暮らし'];

/** 一覧の上のタブ。先頭は「すべて」で、選んだトピックを候補の順に並べる（候補にないものは出さない）。 */
export function categoryTabs(selected: string[] | undefined): string[] {
  const chosen = new Set(selected ?? DEFAULT_CATEGORY_TABS);
  return ['すべて', ...TOPICS.filter(topic => chosen.has(topic))];
}

/** タブに出すトピックを切り替える。まだ選んでいなければ既定の5つから始める。 */
export function toggleCategoryTab(selected: string[] | undefined, topic: string): string[] {
  const current = selected ?? DEFAULT_CATEGORY_TABS;
  return current.includes(topic) ? current.filter(item => item !== topic) : [...current, topic];
}

/** 記事の見出し・概要・RSSのカテゴリに含まれる言葉で付けるタグ（大文字小文字は区別しない）。 */
const TOPIC_RULES: [string, RegExp][] = [
  ['AI・機械学習', /\bai\b|人工知能|生成ai|機械学習|llm|openai|chatgpt|deep learning|machine learning/i],
  ['デザイン', /デザイン|design|\bux\b|\bui\b|figma|タイポグラフィ/i],
  ['テクノロジー', /テクノロジー|technology|ガジェット|スマートフォン|デバイス|半導体/i],
  ['ビジネス', /ビジネス|business|経営|マーケティング|経済|売上|働き方/i],
  ['サイエンス', /サイエンス|science|科学|宇宙|生物|物理|研究|研究所/i],
  ['スタートアップ', /スタートアップ|startup|起業|資金調達|ベンチャー/i],
  ['暮らし', /暮らし|生活|料理|住まい|旅行|ライフスタイル|lifestyle/i],
  ['開発', /開発|プログラ|エンジニア|typescript|javascript|github|\brust\b|\breact\b|\bpython\b|developer|software/i],
  ['プロダクト', /プロダクト|\bproducts?\b|新製品|新機能|発売|ローンチ|\blaunch(?:es|ed)?\b/i],
  ['セキュリティ', /セキュリティ|\bsecurity\b|脆弱性|不正アクセス|マルウェア|ランサムウェア|情報漏[洩えい]|フィッシング|サイバー攻撃|\bcve-\d|\bvulnerabilit(?:y|ies)\b|\bmalware\b|\bransomware\b|\bphishing\b/i],
  // 「株」1文字は「株式会社」に当たるので使わない。
  ['投資・マネー', /投資|株価|株式市場|株主|日経平均|為替|円安|円高|金利|\bnisa\b|nisa|\bideco\b|決算|相場|資産運用|配当|仮想通貨|暗号資産|ビットコイン|マネー|\bstocks?\b|\binvest(?:ing|ment|ments|or|ors)?\b|\bfinance\b/i],
  ['ゲーム', /ゲーム|\bgames?\b|\bgaming\b|任天堂|ニンテンドー|\bnintendo\b|\bplaystation\b|\bps5\b|\bxbox\b|\bsteam\b|eスポーツ|\besports\b/i],
  ['カルチャー', /カルチャー|\bcultur(?:e|al)\b|文化|映画|音楽|アート|\bart\b|アニメ|漫画|マンガ|小説|書籍|エンタメ|entertainment|\bmovies?\b|\bmusic\b|\bfilms?\b/i],
];

/** 当てはまるトピックをすべて返す。どれにも当てはまらなければ空（「テクノロジー」にはしない）。 */
export function tagTopics(text: string): string[] {
  return TOPIC_RULES.filter(([, rule]) => rule.test(text)).map(([name]) => name);
}

/** AIが返したタグのうち、候補にあるものだけを重複を除いて3個まで残す。 */
export function sanitizeTopics(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && TOPICS.includes(value)))].slice(0, 3);
}
