import { MAX_LIBRARY_BYTES, validateSyncDocument } from './cloud-library.ts';
import type { SyncDocument } from './intelligence-types.ts';

export const MAX_BACKUP_TEXT_BYTES = 16 * 1024 * 1024;

export function parseLibraryBackup(text: string): SyncDocument {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength > MAX_BACKUP_TEXT_BYTES) {
    throw new Error('16MiB以下のバックアップファイルを選んでください。');
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('JSONを読み込めませんでした。Folioから書き出したバックアップを選んでください。');
  }

  if (!validateSyncDocument(document)) {
    throw new Error('バックアップの形式またはバージョンが正しくありません。Folioから書き出したバックアップを選んでください。');
  }
  if (encoder.encode(JSON.stringify(document)).byteLength > MAX_LIBRARY_BYTES) {
    throw new Error('バックアップの内容が4MiBを超えるため読み込めません。データを切り捨てずに復元を中止しました。');
  }
  return document;
}
