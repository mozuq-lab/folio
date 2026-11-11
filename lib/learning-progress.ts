/** 0件のときのバーの長さ（%）。何も学習していなくても、バーがあることが分かるようにする。 */
const START = 12;
/** バーが残りの半分まで伸びる件数。件数が増えるほど伸び方が緩やかになり、100%には届かない。 */
const HALF = 20;

export interface LearningProgress { label: string; percent: number; description: string; }

/**
 * 「おすすめの学習状況」の表示。count は「興味あり」「興味なし」を付けた記事の数。
 * バーは件数が増えるたびに必ず伸び、満タンにはならない（それ以上学べないように見せない）。
 */
export function learningProgress(count: number): LearningProgress {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (!n) return { label: 'はじめの一歩', percent: START, description: '記事の「興味あり」「興味なし」で、好みが伝わります。' };
  return { label: '学習中', percent: Math.floor(START + (100 - START) * n / (n + HALF)), description: `${n}件のフィードバックを反映しています。` };
}
