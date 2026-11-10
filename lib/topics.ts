/** 興味のあるトピックの候補。記事のタグもこの中から付ける。 */
export const TOPICS = [
  'AI・機械学習',
  'デザイン',
  'テクノロジー',
  '開発',
  'スタートアップ',
  'ビジネス',
  'プロダクト',
  'サイエンス',
  'カルチャー',
  '暮らし',
];

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
  ['プロダクト', /プロダクト|product|新製品|新機能|発売|ローンチ|\blaunch(?:es|ed)?\b/i],
  ['カルチャー', /カルチャー|culture|文化|映画|音楽|アート|\bart\b|アニメ|漫画|マンガ|小説|書籍|エンタメ|entertainment|\bmovies?\b|\bmusic\b|\bfilms?\b/i],
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
