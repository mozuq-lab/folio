'use client';

import { useRef, useState } from 'react';
import { Check, FileUp } from 'lucide-react';
import { MAX_BACKUP_TEXT_BYTES, parseLibraryBackup } from '@/lib/library-backup';
import type { SyncDocument } from '@/lib/intelligence-types';

interface BackupPreview {
  document: SyncDocument;
  filename: string;
}

export function LibraryBackupTransfer({ onImport, disabled = false }: {
  onImport: (document: SyncDocument) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const readId = useRef(0);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);

  const reset = () => {
    readId.current += 1;
    setPreview(null);
    setError('');
    setReading(false);
    if (input.current) input.current.value = '';
  };

  const readFile = async (file: File | undefined) => {
    if (disabled || !file) return;
    const currentRead = ++readId.current;
    setPreview(null);
    setError('');
    setReading(true);
    try {
      if (file.size > MAX_BACKUP_TEXT_BYTES) throw new Error('16MiB以下のバックアップファイルを選んでください。');
      const document = parseLibraryBackup(await file.text());
      if (currentRead === readId.current) setPreview({ document, filename: file.name });
    } catch (cause) {
      if (currentRead === readId.current) {
        setError(cause instanceof Error ? cause.message : 'バックアップを読み込めませんでした。');
      }
    } finally {
      if (currentRead === readId.current) setReading(false);
    }
  };

  const importBackup = () => {
    if (disabled || reading || error || !preview) return;
    onImport(preview.document);
    reset();
  };

  return <section className="opml-section feed-transfer" aria-busy={reading}>
    <div className="modal-section-title"><h3>Folioのバックアップを読み込む</h3><span>JSON</span></div>
    <p>Folioから書き出したバックアップで、別のドメインにもライブラリを移せます。</p>
    <p>読み込むと、現在の購読・保存・好み・ノート・AIの結果と、保存・ノート・AIの回答で参照している記事とその既読を、バックアップの内容で置き換えます。それ以外の記事（90日分のバックログ）とその既読はバックアップに含まれません。</p>
    <p>以前の形式のバックアップに含まれる記事と既読は、記事の一覧に取り込みます。</p>
    <div className="opml-actions">
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => input.current?.click()}><FileUp size={15}/>バックアップを選ぶ</button>
      <input ref={input} type="file" accept=".json,application/json" hidden disabled={disabled} aria-label="Folioのバックアップファイル" onChange={event => void readFile(event.target.files?.[0])}/>
    </div>
    {reading && <p role="status">バックアップを確認しています…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {preview && <div className="opml-preview">
      <strong>{preview.filename}</strong>
      <p>内容を確認しました。下のボタンを押すと読み込みます。</p>
      <ul>
        <li><span>購読</span><small>{preview.document.reader.feeds.length}件</small></li>
        <li><span>記事</span><small>{preview.document.reader.articles.length}件</small></li>
        <li><span>保存</span><small>{preview.document.reader.saved.length}件</small></li>
        <li><span>ノート</span><small>{preview.document.intelligence.notes.length}件</small></li>
      </ul>
    </div>}
    <div className="opml-preview-footer">
      <button type="button" className="text-link" onClick={reset}>キャンセル</button>
      <button type="button" className="primary-button" disabled={disabled || reading || !!error || !preview} onClick={importBackup}><Check size={15}/>このバックアップを読み込む</button>
    </div>
  </section>;
}
