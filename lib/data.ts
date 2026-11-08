import type { Article, Feed, Preferences } from './types.ts';

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

export const INITIAL_FEEDS: Feed[] = [
  { id: 'zenn', name: 'Zenn', url: 'https://zenn.dev/feed', website: 'https://zenn.dev', category: '開発', color: '#3EA8FF', initial: 'Z' },
  { id: 'techcrunch', name: 'TechCrunch', url: 'https://techcrunch.com/feed/', website: 'https://techcrunch.com', category: 'スタートアップ', color: '#0A9E43', initial: 'TC' },
  { id: 'theverge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', website: 'https://www.theverge.com', category: 'テクノロジー', color: '#5A35EC', initial: 'V' },
  { id: 'wired', name: 'WIRED', url: 'https://wired.jp/rssfeeder/', website: 'https://wired.jp', category: 'テクノロジー', color: '#252A29', initial: 'W' },
  { id: 'smashing', name: 'Smashing Magazine', url: 'https://www.smashingmagazine.com/feed/', website: 'https://www.smashingmagazine.com', category: 'デザイン', color: '#E75A37', initial: 'S' },
  { id: 'hackernews', name: 'Hacker News', url: 'https://news.ycombinator.com/rss', website: 'https://news.ycombinator.com', category: '開発', color: '#EF7B26', initial: 'Y' },
];

export const DEFAULT_PREFERENCES: Preferences = {
  interests: ['AI・機械学習', 'デザイン', 'テクノロジー'],
  mutedTopics: [],
  topicWeights: {},
  sourceWeights: {},
  diversity: 55,
};

const sampleTime = Date.now();

function sample(
  id: string,
  sourceId: string,
  title: string,
  description: string,
  tags: string[],
  hoursAgo: number,
  readingMinutes: number,
  photo: string,
): Article {
  const feed = INITIAL_FEEDS.find((entry) => entry.id === sourceId)!;
  return {
    id: `sample-${id}`,
    sourceId,
    sourceName: feed.name,
    title,
    description,
    // These are editorial samples, so the link opens the source homepage.
    url: `${feed.website}/#folio-sample-${id}`,
    image: `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=1200&q=85`,
    tags,
    publishedAt: new Date(sampleTime - hoursAgo * 60 * 60 * 1000).toISOString(),
    readingMinutes,
    isSample: true,
  };
}

/** Illustrative stories for the first visit; never presented as fetched news. */
export const SAMPLE_ARTICLES: Article[] = [
  sample(
    'ai-partner', 'wired',
    'AIが「相棒」になる時代。創造性を広げる、新しい働き方',
    '答えを求めるだけでなく、一緒に考える存在へ。人とAIのちょうどいい距離感を、日々の仕事と小さな創作から考えます。',
    ['AI・機械学習', 'テクノロジー'], 0.5, 8,
    'photo-1485827404703-89b55fcc595e',
  ),
  sample(
    'quiet-interface', 'smashing',
    '余白が伝えること。心地よいインターフェースのつくり方',
    '情報を増やすより、伝わる形を整える。余白、色、タイポグラフィから、毎日使いたくなるデジタル体験を見つめ直します。',
    ['デザイン', 'プロダクト'], 1.5, 6,
    'photo-1600210492486-724fe5c67fb0',
  ),
  sample(
    'local-models', 'zenn',
    'ローカルLLMを、もっと身近に。手元のMacから始める実践ガイド',
    '小さな言語モデルを自分の環境で動かしてみる。モデル選びから応答の改善まで、実際に触れながら学ぶための道案内。',
    ['AI・機械学習', '開発'], 2.5, 12,
    'photo-1496181133206-80ce9b88a853',
  ),
  sample(
    'next-internet', 'theverge',
    '次のインターネットは、どこへ向かうのか',
    'つながることが当たり前になった世界で、私たちは何を選ぶのか。新しいデバイスとコミュニティから、これからの風景を探ります。',
    ['テクノロジー', 'カルチャー'], 3.5, 7,
    'photo-1451187580459-43490279c0fa',
  ),
  sample(
    'small-teams', 'techcrunch',
    '「小さくつくる」が強い。次世代スタートアップのプロダクト戦略',
    '少人数だからこそ、ユーザーの声に近づける。仮説を小さく試し、必要なものだけを育てるチームの考え方を紹介します。',
    ['スタートアップ', 'プロダクト'], 4.5, 5,
    'photo-1522071820081-009f0129c71c',
  ),
  sample(
    'human-design', 'smashing',
    '設計から考える、使い続けたくなるデザイン',
    '見た目の美しさと、操作のわかりやすさを両立するには。小さなインタラクションに隠れた、プロダクトの優しさを読み解きます。',
    ['デザイン', 'テクノロジー'], 5.5, 9,
    'photo-1558655146-9f40138edfeb',
  ),
  sample(
    'better-questions', 'zenn',
    'コードを書く前に、問いを立てる。開発者のための思考整理',
    '本当に解くべき課題は何か。仕様の曖昧さを整理し、実装につながる問いへ変えるための、シンプルなアプローチ。',
    ['開発', 'プロダクト'], 7, 6,
    'photo-1519389950473-47ba0277781c',
  ),
  sample(
    'robots-at-home', 'wired',
    '人とロボットが共に暮らす、少し先の日常',
    '家の中で役立つロボットに必要なのは、器用さだけではありません。生活のリズムになじむテクノロジーの可能性を考えます。',
    ['AI・機械学習', '暮らし'], 8, 8,
    'photo-1535378917042-10a22c95931a',
  ),
  sample(
    'browser-creative', 'theverge',
    'ブラウザーから始まる、これからのものづくり',
    'インストール不要のツールが、創作のハードルを下げていく。ウェブの進化と、アイデアをすぐ形にできる環境の話。',
    ['テクノロジー', '開発'], 10, 5,
    'photo-1550745165-9bc0b252726f',
  ),
  sample(
    'japanese-type', 'smashing',
    '読みやすさは設計できる。日本語タイポグラフィの基本',
    '文字の大きさ、行間、そして一行の長さ。読む人のリズムをつくる、小さくて大切なデザインの選択をまとめました。',
    ['デザイン'], 12, 7,
    'photo-1507842217343-583bb7270b66',
  ),
  sample(
    'new-workspaces', 'techcrunch',
    'アイデアを育てる場所。新しいワークスペースのかたち',
    '集中する時間と、偶然の会話。その両方を支える場所を、働く人の視点から見直す、新しいオフィスづくりのヒント。',
    ['スタートアップ', '暮らし'], 14, 4,
    'photo-1497366811353-6870744d04b2',
  ),
  sample(
    'open-knowledge', 'hackernews',
    'オープンソースがつなぐ、知識の循環',
    '誰かの小さな改善が、世界中のものづくりを支えている。使う人から参加する人へ、一歩を踏み出すための読みもの。',
    ['開発', 'テクノロジー'], 16, 6,
    'photo-1555066931-4365d14bab8c',
  ),
  sample(
    'data-stories', 'wired',
    'データの向こうに、人がいる。数字から世界を読む方法',
    '複雑な社会を理解するために、データは何を教えてくれるのか。可視化の工夫と、その背景にある物語を探ります。',
    ['サイエンス', 'デザイン'], 19, 10,
    'photo-1460925895917-afdab827c52f',
  ),
  sample(
    'calm-tech', 'theverge',
    '通知を減らすと、見えてくる。穏やかなテクノロジーとの付き合い方',
    '便利さの先にある、落ち着いた毎日。自分の時間を取り戻すための設定と、情報を選んで受け取る習慣を考えます。',
    ['テクノロジー', '暮らし'], 23, 5,
    'photo-1441974231531-c6227db76b6e',
  ),
  sample(
    'creative-tools', 'hackernews',
    'つくる楽しさを取り戻す、週末の小さなプロジェクト',
    '完璧な計画がなくても、手を動かすことで始まる発見がある。遊び心から生まれるツールと、個人開発の面白さ。',
    ['開発', 'カルチャー'], 28, 7,
    'photo-1513364776144-60967b0f800f',
  ),
];
