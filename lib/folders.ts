import type { Feed } from './types.ts';

/** 分類。feedIds の順がその分類の中での並び順。同じフィードが複数の分類に入れる。 */
export type FeedFolder = { name: string; feedIds: string[] };
export type FeedGroup = { name: string; feeds: Feed[]; unfiled: boolean };

/** どの分類にも入っていないフィードの表示名。分類の名前には使えない。 */
export const UNFILED = '未分類';
export const MAX_FOLDERS = 100;
export const MAX_FOLDER_NAME = 40;
/** 保存した分類が無いときの並び順（これまでのサイドバーと同じ）。ここに無い分類は購読の順に後ろへ並べる。 */
const DEFAULT_ORDER = ['テクノロジー', 'デザイン', 'ビジネス', 'サイエンス', '暮らし'];

/**
 * 表示と編集に使う分類。保存が無ければ各フィードの分類名（category）から作る。
 * 保存があれば、購読していないIDと分類内の重複を除く。空の分類も残す。
 */
export function resolveFolders(feeds: Feed[], folders: FeedFolder[] | undefined): FeedFolder[] {
  const ids = new Set(feeds.map(feed => feed.id));
  if (folders) return folders.map(folder => ({ name: folder.name, feedIds: [...new Set(folder.feedIds)].filter(id => ids.has(id)) }));
  const byName = new Map<string, string[]>();
  for (const feed of feeds) {
    if (!feed.category || feed.category === UNFILED) continue;
    const list = byName.get(feed.category) ?? [];
    if (!list.includes(feed.id)) list.push(feed.id);
    byName.set(feed.category, list);
  }
  const names = [...DEFAULT_ORDER.filter(name => byName.has(name)), ...[...byName.keys()].filter(name => !DEFAULT_ORDER.includes(name))];
  return names.map(name => ({ name, feedIds: byName.get(name)! }));
}

const unfiledOf = (feeds: Feed[], folders: FeedFolder[]) => {
  const filed = new Set(folders.flatMap(folder => folder.feedIds));
  return feeds.filter(feed => !filed.has(feed.id));
};

/** サイドバーの並び。空でない分類を順に並べ、どこにも入っていないフィードを最後の「未分類」にまとめる。 */
export function sidebarGroups(feeds: Feed[], folders: FeedFolder[]): FeedGroup[] {
  const byId = new Map(feeds.map(feed => [feed.id, feed] as const));
  const groups: FeedGroup[] = folders
    .map(folder => ({ name: folder.name, feeds: folder.feedIds.map(id => byId.get(id)).filter((feed): feed is Feed => !!feed), unfiled: false }))
    .filter(group => group.feeds.length > 0);
  const unfiled = unfiledOf(feeds, folders);
  if (unfiled.length) groups.push({ name: UNFILED, feeds: unfiled, unfiled: true });
  return groups;
}

/** 分類（または「未分類」）に入っているフィードのID。 */
export function folderFeedIds(feeds: Feed[], folders: FeedFolder[], name: string): string[] {
  const folder = folders.find(item => item.name === name);
  if (folder) return folder.feedIds;
  return name === UNFILED ? unfiledOf(feeds, folders).map(feed => feed.id) : [];
}

function nameError(folders: FeedFolder[], name: string, except?: string): string | null {
  if (!name) return '分類の名前を入力してください。';
  if (Array.from(name).length > MAX_FOLDER_NAME) return `分類の名前は${MAX_FOLDER_NAME}文字以内にしてください。`;
  if (name === UNFILED) return `「${UNFILED}」は分類の名前に使えません。`;
  if (name !== except && folders.some(folder => folder.name === name)) return '同じ名前の分類があります。';
  return null;
}

export function createFolder(folders: FeedFolder[], raw: string): { folders: FeedFolder[]; error: string | null } {
  const name = raw.trim();
  const error = folders.length >= MAX_FOLDERS ? `分類は${MAX_FOLDERS}件まで作れます。` : nameError(folders, name);
  return error ? { folders, error } : { folders: [...folders, { name, feedIds: [] }], error: null };
}

export function renameFolder(folders: FeedFolder[], from: string, raw: string): { folders: FeedFolder[]; error: string | null } {
  const name = raw.trim();
  const error = nameError(folders, name, from);
  return error ? { folders, error } : { folders: folders.map(folder => folder.name === from ? { ...folder, name } : folder), error: null };
}

/** 分類を消す。中のフィードは購読したまま、ほかの分類に入っていなければ「未分類」になる。 */
export function deleteFolder(folders: FeedFolder[], name: string): FeedFolder[] {
  return folders.filter(folder => folder.name !== name);
}

function move<T>(list: T[], from: number, to: number): T[] {
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (from < 0 || from >= list.length || from === target) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

export function moveFolder(folders: FeedFolder[], from: number, to: number): FeedFolder[] {
  return move(folders, from, to);
}

export function moveFeedInFolder(folders: FeedFolder[], name: string, from: number, to: number): FeedFolder[] {
  return folders.map(folder => folder.name === name ? { ...folder, feedIds: move(folder.feedIds, from, to) } : folder);
}

/** フィードの所属を names にする。新しく入る分類では最後に足し、すでに入っている分類では位置を変えない。 */
export function setFeedFolders(folders: FeedFolder[], feedId: string, names: string[]): FeedFolder[] {
  const wanted = new Set(names);
  return folders.map(folder => {
    const has = folder.feedIds.includes(feedId);
    if (wanted.has(folder.name) === has) return folder;
    return { ...folder, feedIds: has ? folder.feedIds.filter(id => id !== feedId) : [...folder.feedIds, feedId] };
  });
}

export function removeFeedFromFolders(folders: FeedFolder[], feedId: string): FeedFolder[] {
  return setFeedFolders(folders, feedId, []);
}

/** 「未分類」の中だけで並べ替える。購読一覧の中の未分類のフィードの位置に、新しい順で入れ直す。 */
export function moveUnfiledFeed(feeds: Feed[], folders: FeedFolder[], from: number, to: number): Feed[] {
  const unfiled = unfiledOf(feeds, folders);
  const moved = move(unfiled, from, to);
  if (moved === unfiled) return feeds;
  const ids = new Set(unfiled.map(feed => feed.id));
  let next = 0;
  return feeds.map(feed => ids.has(feed.id) ? moved[next++] : feed);
}

/** 新しく購読したフィードを、分類名（category）の分類の最後に入れる。その分類が無ければ最後に作る。 */
export function addFeedsToFolders(folders: FeedFolder[], feeds: Feed[]): FeedFolder[] {
  let next = folders;
  for (const feed of feeds) {
    const name = feed.category?.trim();
    if (!name || name === UNFILED || Array.from(name).length > MAX_FOLDER_NAME) continue;
    const folder = next.find(item => item.name === name);
    if (folder?.feedIds.includes(feed.id)) continue;
    if (!folder && next.length >= MAX_FOLDERS) continue;
    next = folder ? next.map(item => item === folder ? { ...item, feedIds: [...item.feedIds, feed.id] } : item) : [...next, { name, feedIds: [feed.id] }];
  }
  return next;
}

/** 各フィードの分類名（category）を、入っている最初の分類にそろえる。OPMLの書き出しや以前の画面との互換のため。 */
export function withCategories(feeds: Feed[], folders: FeedFolder[]): Feed[] {
  const first = new Map<string, string>();
  for (const folder of folders) for (const id of folder.feedIds) if (!first.has(id)) first.set(id, folder.name);
  return feeds.map(feed => {
    const category = first.get(feed.id) ?? UNFILED;
    return feed.category === category ? feed : { ...feed, category };
  });
}
