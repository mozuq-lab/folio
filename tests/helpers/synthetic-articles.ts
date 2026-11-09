import type { Article } from '../../lib/types.ts';

const DAY = 86_400_000;

/** 再現できる擬似乱数（mulberry32）。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = ['AI', '開発', 'セキュリティ', 'ビジネス', '科学', 'ゲーム', '政治', '経済', 'スポーツ', '暮らし', 'デザイン', 'クラウド', 'モバイル', '宇宙', '医療'];
const JA_SUBJECTS = ['任天堂', 'ソニー', 'トヨタ', '政府', '日銀', '東京都', 'ソフトバンク', '楽天', 'NTT', 'パナソニック', '富士通', '日立', '気象庁', '総務省', '経産省', 'メルカリ', 'サイバーエージェント', 'KDDI', '大阪府', '京都大学', '東京大学', 'JAXA', '厚生労働省', 'ホンダ', '日産'];
const JA_OBJECTS = ['新型ゲーム機', '生成AIサービス', '電気自動車', '半導体工場', '決済アプリ', '量子コンピューター', 'クラウド基盤', '防災システム', '新しい料金プラン', '研究施設', '人工衛星', '医療データ基盤', 'スマートフォン', '配送ロボット', '教育アプリ', '再生可能エネルギー事業', '観光キャンペーン', '旅行予約サービス', '音楽配信サービス', '自動運転バス'];
const JA_VERBS = ['を発表', 'を発売', 'の提供を開始', 'を公開', 'の計画を明らかに', 'を大幅に刷新', 'の実証実験を開始', 'の受付を開始', 'に脆弱性', 'の価格を改定'];
const JA_DETAILS = ['国内価格を発表', '来年春に投入', '海外展開も視野', '利用者は100万人を突破', '専門家は慎重な見方', '競合各社も追随', '記者会見で詳細を説明', '初年度の売上目標を設定', '対象地域を順次拡大', '提供時期は未定'];
const EN_SUBJECTS = ['Apple', 'Google', 'Microsoft', 'Amazon', 'Meta', 'OpenAI', 'Nvidia', 'Tesla', 'Netflix', 'Samsung', 'Intel', 'Cloudflare', 'Mozilla', 'GitHub', 'Stripe', 'Spotify', 'Adobe', 'Oracle', 'IBM', 'Anthropic', 'Valve', 'Uber', 'Airbnb', 'Shopify', 'Reddit'];
const EN_VERBS = ['launches', 'announces', 'releases', 'acquires', 'delays', 'unveils', 'discontinues', 'updates', 'expands', 'tests'];
const EN_OBJECTS = ['new browser', 'AI assistant', 'developer platform', 'security update', 'streaming service', 'chip design', 'cloud region', 'payment API', 'smart glasses', 'robotics lab', 'data center', 'open source model', 'subscription plan', 'privacy controls', 'game engine', 'search feature', 'mobile app', 'translation tool', 'battery tech', 'satellite network'];
const EN_DETAILS = ['for Mac', 'in Europe', 'with pricing details', 'ahead of schedule', 'after regulatory review', 'for enterprise customers', 'amid criticism', 'to rival competitors', 'with new partners', 'for developers'];
const JA_SENTENCES = ['関係者によると、提供は段階的に進める方針です。', '利用者からは期待と不安の声が上がっています。', '同社は詳細を後日公表するとしています。', '業界全体への影響が注目されています。', '専門家は今後の動向を見守る必要があると指摘しました。', '価格は従来モデルより引き上げられる見通しです。', '安全性の検証には時間がかかるとみられます。'];
const EN_SENTENCES = ['The company said the rollout will happen in stages.', 'Analysts expect competitors to respond quickly.', 'Pricing will be announced later this year.', 'Critics raised concerns about privacy and security.', 'The update is available to all users starting today.', 'Regulators are reviewing the deal.', 'Early benchmarks show significant improvements.'];

const KANA = ['ア', 'イ', 'カ', 'キ', 'ク', 'サ', 'シ', 'ス', 'タ', 'ト', 'ナ', 'ニ', 'ハ', 'フ', 'マ', 'ミ', 'ラ', 'リ', 'ル', 'レ', 'ロ', 'ワ', 'ジ', 'ゼ', 'ド', 'バ', 'ビ', 'ポ', 'ン', 'ー'];
const SYLLABLES = ['zen', 'tri', 'lo', 'ma', 'vex', 'ka', 'ri', 'on', 'qua', 'dra', 'nis', 'el', 'pho', 'ty', 'gon', 'sa', 'mi', 'rel', 'xo', 'bu'];

const pick = <T>(rand: () => number, values: T[]): T => values[Math.floor(rand() * values.length)];
/** ニュースごとの固有名詞（製品名など）。実際の見出しと同じく、話題ごとに珍しい語を含める。 */
const katakanaName = (rand: () => number): string => Array.from({ length: 3 + Math.floor(rand() * 3) }, () => pick(rand, KANA)).join('');
const latinName = (rand: () => number): string => {
  const name = Array.from({ length: 2 + Math.floor(rand() * 2) }, () => pick(rand, SYLLABLES)).join('');
  return name[0].toUpperCase() + name.slice(1);
};

/**
 * 性能テスト用の合成記事。約30媒体・日本語と英語・タグ付き・90日に分散させ、
 * 同じニュースを複数媒体が少し違う見出しで報じる記事も含める。seedが同じなら同じ配列を返す。
 */
export function syntheticArticles(count: number, options: { seed?: number; now?: number; days?: number; sources?: number } = {}): Article[] {
  const rand = random(options.seed ?? 20261109);
  const now = options.now ?? Date.parse('2026-11-09T00:00:00Z');
  const days = options.days ?? 90;
  const sourceCount = options.sources ?? 30;
  const sources = Array.from({ length: sourceCount }, (_, i) => ({ id: `source-${i}`, name: i % 2 ? `Tech News ${i}` : `ニュース${i}` }));
  const articles: Article[] = [];
  while (articles.length < count) {
    const japanese = rand() < 0.6;
    const subject = pick(rand, japanese ? JA_SUBJECTS : EN_SUBJECTS);
    const object = pick(rand, japanese ? JA_OBJECTS : EN_OBJECTS);
    const name = japanese ? katakanaName(rand) : latinName(rand);
    const version = rand() < 0.3 ? ` ${1 + Math.floor(rand() * 20)}` : '';
    const published = now - rand() * days * DAY;
    const tags = [pick(rand, TAGS), ...(rand() < 0.5 ? [pick(rand, TAGS)] : [])];
    const sentences = japanese ? JA_SENTENCES : EN_SENTENCES;
    const lead = japanese ? `${subject}は${rand() < 0.5 ? '本日' : '先週'}、${object}「${name}${version}」について明らかにしました。` : `${subject} said ${name}${version} is its new ${object}.`;
    // 1つのニュースを1〜4媒体が報じ、ときどき数日後に続報が出る。見出しの動詞・末尾と概要は媒体ごとに少し変える。
    const coverage = rand() < 0.7 ? 1 : 2 + Math.floor(rand() * 3);
    for (let c = 0; c < coverage && articles.length < count; c++) {
      const source = pick(rand, sources);
      const verb = pick(rand, japanese ? JA_VERBS : EN_VERBS);
      const detail = pick(rand, japanese ? JA_DETAILS : EN_DETAILS);
      const title = japanese ? `${subject}が${object}「${name}${version}」${verb}、${detail}` : `${subject} ${verb} ${name}${version} ${object} ${detail}`;
      const description = [lead, pick(rand, sentences), pick(rand, sentences)].join(japanese ? '' : ' ');
      const later = rand() < 0.2 ? rand() * 5 * DAY : rand() * 6 * 3_600_000;
      articles.push({
        id: `article-${articles.length}`, title, description,
        url: `https://${source.id}.example.com/news/${articles.length}${rand() < 0.2 ? '?utm_source=rss' : ''}`,
        sourceId: source.id, sourceName: source.name,
        publishedAt: new Date(Math.min(now, published + later)).toISOString(),
        tags: [...new Set(tags)], readingMinutes: 1 + Math.floor(rand() * 10),
      });
    }
  }
  return articles;
}
