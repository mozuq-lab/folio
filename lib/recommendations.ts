import type { Article, Feedback, Preferences, RankedArticle } from './types.ts';

const HOUR = 60 * 60 * 1000;

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function timestamp(value: string): number {
  return finite(Date.parse(value));
}

function compareIds(a: Article, b: Article): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

/** Content-based ranking; no external AI or personal data leaves the browser. */
export function rankArticles(
  articles: Article[],
  preferences: Preferences,
  feedback: Feedback,
  now = Date.now(),
): RankedArticle[] {
  const currentTime = finite(now, Date.now());
  const interests = new Set(preferences.interests);
  const muted = new Set(preferences.mutedTopics);
  const diversity = clamp(finite(preferences.diversity), 0, 100) / 100;
  const candidates = articles
    // 興味なしの記事は一覧から消さず、順位を下げる（押し間違えても一覧から戻せるように）。
    .filter((article) => !article.tags.some((tag) => muted.has(tag)))
    .map((article, order) => {
      const tags = [...new Set(article.tags)];
      const matches = tags.filter((tag) => interests.has(tag));
      const topicWeight = tags.reduce((sum, tag) => sum + clamp(finite(preferences.topicWeights[tag]), -6, 6), 0);
      const sourceWeight = finite(preferences.sourceWeights[article.sourceId]);
      const published = timestamp(article.publishedAt);
      const ageHours = Math.max(0, (currentTime - published) / HOUR);
      const freshness = published === 0 ? 0 : 20 * Math.exp(-ageHours / 120);
      const liked = feedback[article.id] === 'like';
      const disliked = feedback[article.id] === 'dislike';
      const value = 34
        + Math.min(matches.length, 2) * 22
        + clamp(topicWeight * 4, -24, 24)
        + clamp(sourceWeight * 4, -12, 12)
        + freshness
        + (liked ? 14 : 0)
        - (disliked ? 14 : 0);
      const learnedTopic = tags.find((tag) => finite(preferences.topicWeights[tag]) > 0);
      const reason = liked
        ? '「興味あり」にした記事'
        : disliked
          ? '「興味なし」にした記事'
          : matches.length
            ? `${matches.slice(0, 2).join('・')}への興味にマッチ`
            : learnedTopic
              ? `最近の反応から、${learnedTopic}をおすすめ`
              : sourceWeight > 0
                ? '関心を示したメディアからのおすすめ'
                : ageHours < 24
                  ? '新しく届いた、発見につながる記事'
                  : 'いつもと少し違う視点を届けます';
      return { article, tags, value: clamp(value, 0, 99), reason, published, order };
    });
  type Candidate = (typeof candidates)[number];

  const sourceCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const result: RankedArticle[] = [];
  const adjustedScore = (candidate: Candidate) => {
    const sourcePenalty = Math.min(sourceCounts.get(candidate.article.sourceId) ?? 0, 3) * 12;
    const topicPenalty = candidate.tags.length
      ? candidate.tags.reduce((sum, tag) => sum + Math.min(topicCounts.get(tag) ?? 0, 4), 0) / candidate.tags.length * 3
      : 0;
    return candidate.value - diversity * (sourcePenalty + topicPenalty);
  };

  // Greedy selection reduces repetition while preserving relevance and stable ties.
  // 選ぶたびに全件を並べ直すと件数の2乗になる。減点は選ぶほど増える一方なので、各記事を前回の点数で
  // 優先度付きキューに置き、先頭を取り出したときに計算し直す（下がっていれば置き直す）。
  // 選ばれる順は「毎回全件を点数・新しさ・IDの順に並べて先頭を取る」場合と同じ（IDとURLまで同じ記事どうしは入力順）。
  const heap = candidates.map((candidate) => ({ candidate, score: adjustedScore(candidate) }));
  type Entry = (typeof heap)[number];
  const before = (a: Entry, b: Entry): boolean => {
    if (a.score !== b.score) return a.score > b.score;
    if (a.candidate.published !== b.candidate.published) return a.candidate.published > b.candidate.published;
    const byId = compareIds(a.candidate.article, b.candidate.article);
    return byId ? byId < 0 : a.candidate.order < b.candidate.order;
  };
  const siftDown = (index: number) => {
    for (;;) {
      const left = index * 2 + 1, right = left + 1;
      let best = index;
      if (left < heap.length && before(heap[left], heap[best])) best = left;
      if (right < heap.length && before(heap[right], heap[best])) best = right;
      if (best === index) return;
      [heap[index], heap[best]] = [heap[best], heap[index]];
      index = best;
    }
  };
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) siftDown(i);
  while (heap.length) {
    const top = heap[0];
    const score = adjustedScore(top.candidate);
    if (score < top.score) { top.score = score; siftDown(0); continue; }
    const last = heap.pop()!;
    if (heap.length) { heap[0] = last; siftDown(0); }
    const selected = top.candidate;
    result.push({ ...selected.article, score: Math.round(clamp(score, 0, 99)), reason: selected.reason });
    sourceCounts.set(selected.article.sourceId, (sourceCounts.get(selected.article.sourceId) ?? 0) + 1);
    selected.tags.forEach((tag) => topicCounts.set(tag, (topicCounts.get(tag) ?? 0) + 1));
  }
  return result;
}

export function applyFeedback(
  preferences: Preferences,
  article: Article,
  previous: 'like' | 'dislike' | undefined,
  next: 'like' | 'dislike' | undefined,
): Preferences {
  if (previous === next) return preferences;
  const impact = (reaction: typeof previous) => reaction === 'like' ? 1 : reaction === 'dislike' ? -1 : 0;
  const delta = impact(next) - impact(previous);
  const topicWeights = { ...preferences.topicWeights };
  const sourceWeights = { ...preferences.sourceWeights };
  const update = (weights: Record<string, number>, key: string, amount: number) => {
    const value = finite(weights[key]) + amount;
    if (value === 0) delete weights[key];
    else weights[key] = value;
  };
  // Keep learning additive so changing or clearing feedback exactly undoes it.
  // Its contribution is bounded in rankArticles instead of losing history here.
  [...new Set(article.tags)].forEach((tag) => update(topicWeights, tag, delta * 2));
  update(sourceWeights, article.sourceId, delta);
  return { ...preferences, topicWeights, sourceWeights };
}
