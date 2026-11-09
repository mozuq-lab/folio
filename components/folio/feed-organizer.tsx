'use client';

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Check, FolderPlus, GripVertical, Pencil, Search, Tags, Trash2, X } from 'lucide-react';
import { FeedIcon } from './feed-icon';
import { formatFetchState, type FeedFetchState } from '../../lib/backlog/priority';
import { createFolder, deleteFolder, moveFeedInFolder, moveFolder, renameFolder, setFeedFolders, sidebarGroups, type FeedFolder } from '../../lib/folders';
import { filterFeeds } from '../../lib/sidebar';
import type { Feed } from '../../lib/types';

type Drag = { kind: 'folder'; index: number } | { kind: 'feed'; group: string; index: number } | null;
type DragHandlers = { draggable: boolean; onDragStart: (event: DragEvent) => void; onDragEnd: () => void; onDragOver: (event: DragEvent) => void; onDrop: (event: DragEvent) => void };

export type FeedOrganizerProps = {
  feeds: Feed[];
  folders: FeedFolder[];
  fetchStates: Record<string, FeedFetchState>;
  showFetchStates: boolean;
  onTogglePriority: (feedId: string) => void;
  onRemove: (feed: Feed) => void;
  /** 分類を変える。結果の分類に合わせて各フィードの category も呼び出し側でそろえる。 */
  onOrganize: (change: (folders: FeedFolder[]) => FeedFolder[]) => void;
  onMoveUnfiled: (from: number, to: number) => void;
  /** 分類の名前を変えたとき（サイドバーの開閉の状態を引き継ぐため）。 */
  onFolderRenamed?: (from: string, to: string) => void;
};

/** フィードの管理の「分類」と「購読中のフィード」。並び替えはドラッグか ↑↓ ボタン。フィードは複数の分類に入れる。 */
export function FeedOrganizer(props: FeedOrganizerProps) {
  const { feeds, folders, onOrganize } = props;
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [drag, setDrag] = useState<Drag>(null);
  const [announcement, setAnnouncement] = useState('');
  const root = useRef<HTMLDivElement>(null);
  // ↑↓ で動かしたあと、並び直した行の同じボタン（端に着いて押せなければ反対のボタン）にフォーカスを戻す。
  const focusAfterMove = useRef<{ key: string; direction: 'up' | 'down' } | null>(null);
  useEffect(() => {
    const target = focusAfterMove.current;
    if (!target || !root.current) return;
    focusAfterMove.current = null;
    const find = (direction: string) => root.current?.querySelector<HTMLButtonElement>(`[data-move="${CSS.escape(`${target.key}:${direction}`)}"]`);
    const button = find(target.direction);
    (button && !button.disabled ? button : find(target.direction === 'up' ? 'down' : 'up'))?.focus();
  });
  const moved = (key: string, label: string, direction: 'up' | 'down', position: number) => {
    focusAfterMove.current = { key, direction };
    setAnnouncement(`「${label}」を${position}番目に移動しました。`);
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    const result = createFolder(folders, newName);
    setError(result.error ?? '');
    if (!result.error) { onOrganize(current => createFolder(current, newName).folders); setNewName(''); }
  };
  const rename = (event: FormEvent, from: string) => {
    event.preventDefault();
    const result = renameFolder(folders, from, draftName);
    setError(result.error ?? '');
    if (!result.error) { onOrganize(current => renameFolder(current, from, draftName).folders); props.onFolderRenamed?.(from, draftName.trim()); setEditing(null); }
  };
  // 名前の変更中や分類の選択中は、入力欄を操作できるようにドラッグを止める。
  const dragProps = (target: Exclude<Drag, null>, onDrop: (from: number) => void, enabled = true): DragHandlers => ({
    draggable: enabled,
    onDragStart: (event: DragEvent) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', ''); setDrag(target); },
    onDragEnd: () => setDrag(null),
    onDragOver: (event: DragEvent) => {
      if (drag && drag.kind === target.kind && (drag.kind === 'folder' || (target.kind === 'feed' && drag.group === target.group))) event.preventDefault();
    },
    onDrop: (event: DragEvent) => { event.preventDefault(); if (drag) onDrop(drag.index); setDrag(null); },
  });

  const groups = sidebarGroups(feeds, folders);
  const matches = filterFeeds(feeds, query);
  const searching = query.trim().length > 0;

  return <div ref={root}>
    <p className="visually-hidden" aria-live="polite">{announcement}</p>
    <div className="modal-section-title"><h3>分類</h3><span>{folders.length}件</span></div>
    <p className="organizer-help">ドラッグするか ↑↓ で並び替えます。分類を消しても、中のフィードの購読は続きます。</p>
    <form className="folder-create" onSubmit={create}>
      <input value={newName} onChange={event => { setNewName(event.target.value); setError(''); }} placeholder="新しい分類の名前" aria-label="新しい分類の名前" maxLength={60} />
      <button className="secondary-button" type="submit"><FolderPlus size={15} />作成</button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    <ul className="folder-list">
      {folders.map((folder, index) => <li key={folder.name} className={`folder-item${drag?.kind === 'folder' && drag.index === index ? ' is-dragging' : ''}`} {...dragProps({ kind: 'folder', index }, from => onOrganize(current => moveFolder(current, from, index)), editing !== folder.name)}>
        <GripVertical size={14} className="drag-handle" aria-hidden="true" />
        {editing === folder.name
          ? <form className="folder-rename" onSubmit={event => rename(event, folder.name)}>
            <input value={draftName} onChange={event => { setDraftName(event.target.value); setError(''); }} aria-label={`${folder.name}の新しい名前`} maxLength={60} autoFocus />
            <button className="icon-button" type="submit" aria-label="名前を保存"><Check size={15} /></button>
            <button className="icon-button" type="button" aria-label="名前の変更をやめる" onClick={() => { setEditing(null); setError(''); }}><X size={15} /></button>
          </form>
          : <>
            <span className="folder-item-name">{folder.name}</span><small>{folder.feedIds.length}件</small>
            <button className="icon-button" type="button" data-move={`folder:${folder.name}:up`} aria-label={`${folder.name}を上へ`} disabled={index === 0} onClick={() => { onOrganize(current => moveFolder(current, index, index - 1)); moved(`folder:${folder.name}`, folder.name, 'up', index); }}><ArrowUp size={14} /></button>
            <button className="icon-button" type="button" data-move={`folder:${folder.name}:down`} aria-label={`${folder.name}を下へ`} disabled={index === folders.length - 1} onClick={() => { onOrganize(current => moveFolder(current, index, index + 1)); moved(`folder:${folder.name}`, folder.name, 'down', index + 2); }}><ArrowDown size={14} /></button>
            <button className="icon-button" type="button" aria-label={`${folder.name}の名前を変更`} onClick={() => { setEditing(folder.name); setDraftName(folder.name); setError(''); }}><Pencil size={14} /></button>
            <button className="icon-button delete-button" type="button" aria-label={`分類「${folder.name}」を削除`} onClick={() => onOrganize(current => deleteFolder(current, folder.name))}><Trash2 size={14} /></button>
          </>}
      </li>)}
      {!folders.length && <li className="muted">分類はまだありません。</li>}
    </ul>

    <div className="modal-section-title"><h3>購読中のフィード</h3><span>{feeds.length}件</span></div>
    {feeds.length > 0 && <div className="feed-search"><Search size={14} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="フィード名またはURLで検索" aria-label="購読中のフィードを検索" /></div>}
    <div className="manage-feeds">
      {!feeds.length && <p className="muted">購読中のフィードはありません。上から追加できます。</p>}
      {searching && !matches.length && <p className="muted">「{query.trim()}」に一致するフィードはありません。</p>}
      {searching
        ? matches.map(feed => <FeedRow key={feed.id} {...props} feed={feed} />)
        : groups.map(group => <section className="manage-group" key={group.name} aria-label={group.name}>
          <h4>{group.name}<span>{group.feeds.length}件</span></h4>
          {group.feeds.map((feed, index) => {
            const move = (from: number, to: number) => group.unfiled ? props.onMoveUnfiled(from, to) : onOrganize(current => moveFeedInFolder(current, group.name, from, to));
            return <FeedRow key={feed.id} {...props} feed={feed}
              order={{ label: group.name, moveKey: `feed:${group.name}:${feed.id}`, first: index === 0, last: index === group.feeds.length - 1,
                up: () => { move(index, index - 1); moved(`feed:${group.name}:${feed.id}`, feed.name, 'up', index); },
                down: () => { move(index, index + 1); moved(`feed:${group.name}:${feed.id}`, feed.name, 'down', index + 2); } }}
              drag={{ ...dragProps({ kind: 'feed', group: group.name, index }, from => move(from, index)), dragging: drag?.kind === 'feed' && drag.group === group.name && drag.index === index }} />;
          })}
        </section>)}
    </div>
  </div>;
}

type RowProps = FeedOrganizerProps & {
  feed: Feed;
  order?: { label: string; moveKey: string; first: boolean; last: boolean; up: () => void; down: () => void };
  drag?: DragHandlers & { dragging: boolean };
};

function FeedRow({ feed, folders, fetchStates, showFetchStates, onTogglePriority, onRemove, onOrganize, order, drag }: RowProps) {
  const [choosing, setChoosing] = useState(false);
  const member = folders.filter(folder => folder.feedIds.includes(feed.id)).map(folder => folder.name);
  const toggle = (name: string) => onOrganize(current => setFeedFolders(current, feed.id, member.includes(name) ? member.filter(item => item !== name) : [...member, name]));
  const { dragging = false, ...handlers } = drag ?? {};
  return <div className={`manage-feed${dragging ? ' is-dragging' : ''}`} {...handlers} draggable={!!drag && !choosing}>
    {order && <GripVertical size={14} className="drag-handle" aria-hidden="true" />}
    <FeedIcon feed={feed} />
    <div className="manage-feed-info">
      <strong>{feed.name}</strong>
      {/^https:\/\//i.test(feed.url) ? <a className="feed-url" href={feed.url} target="_blank" rel="noopener noreferrer">{feed.url}</a> : <span>{feed.url}</span>}
      {showFetchStates && <span className="feed-fetch-state">{formatFetchState(fetchStates[feed.id], new Date())}</span>}
      {choosing && <fieldset className="folder-choices"><legend>{feed.name}の分類</legend>
        {folders.length ? folders.map(folder => <label key={folder.name}><input type="checkbox" checked={member.includes(folder.name)} onChange={() => toggle(folder.name)} />{folder.name}</label>) : <span>先に「分類」で分類を作ってください。</span>}
      </fieldset>}
    </div>
    <div className="manage-feed-actions">
    {order && <>
      <button className="icon-button" type="button" data-move={`${order.moveKey}:up`} aria-label={`${feed.name}を${order.label}の中で上へ`} disabled={order.first} onClick={order.up}><ArrowUp size={14} /></button>
      <button className="icon-button" type="button" data-move={`${order.moveKey}:down`} aria-label={`${feed.name}を${order.label}の中で下へ`} disabled={order.last} onClick={order.down}><ArrowDown size={14} /></button>
    </>}
    <button type="button" className={`folder-choose${choosing ? ' active' : ''}`} aria-expanded={choosing} onClick={() => setChoosing(open => !open)}><Tags size={13} />{member.length ? member.join('・') : '未分類'}</button>
    <button type="button" className={`priority-toggle${feed.priority ? ' active' : ''}`} aria-pressed={!!feed.priority} onClick={() => onTogglePriority(feed.id)}>優先して取得</button>
    <button className="icon-button delete-button" type="button" aria-label={`${feed.name}の購読を解除`} onClick={() => onRemove(feed)}><Trash2 size={16} /></button>
    </div>
  </div>;
}
