/** 上部バーの出し入れの状態。anchor は最後に判定したときのスクロール位置。 */
export interface TopbarScroll { hidden: boolean; anchor: number; }

/**
 * スマホ表示で、下へスクロールしたら上部バーを隠し、上へ戻したら出す。
 * 1回のスクロールイベントで動く量は小さいので、前回判定した位置（anchor）からの移動量で判定する。
 * reveal より上（ページの先頭近く）では常に出す。threshold は向きを判定する移動量。
 */
export function nextTopbarScroll(state: TopbarScroll, y: number, { reveal, threshold }: { reveal: number; threshold: number }): TopbarScroll {
  if (!Number.isFinite(y)) return state;
  if (y <= reveal) return { hidden: false, anchor: y };
  const moved = y - state.anchor;
  if (moved > threshold) return { hidden: true, anchor: y };
  if (moved < -threshold) return { hidden: false, anchor: y };
  return state;
}
