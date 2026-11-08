import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, act } from 'react';
import { parseHTML } from 'linkedom';
import ts from 'typescript';
import { parseLibraryBackup } from '../lib/library-backup.ts';
import { MAX_LIBRARY_BYTES } from '../lib/cloud-library.ts';
import type { SyncDocument } from '../lib/intelligence-types.ts';

function backup(): SyncDocument {
  return {
    version: 2,
    reader: {
      version: 1,
      feeds: [{ id: 'source', name: '購読元', url: 'https://example.com/feed', website: 'https://example.com', category: '技術', color: '#123456', initial: '購' }],
      articles: [{ id: 'article', title: '保存する記事', description: '概要', url: 'https://example.com/article', image: 'https://example.com/image.png', sourceId: 'source', sourceName: '購読元', publishedAt: '2026-11-07T10:00:00Z', tags: ['AI'], readingMinutes: 7, content: '記事の本文と日本語の引用。😀', contentFetchedAt: '2026-11-07T11:00:00Z' }],
      saved: ['article'],
      read: ['article'],
      feedback: { article: 'like' },
      preferences: { interests: ['AI'], mutedTopics: ['広告'], topicWeights: { AI: 4 }, sourceWeights: { source: 2 }, diversity: 35 },
      lastUpdated: '2026-11-07T12:00:00Z',
    },
    intelligence: {
      version: 1,
      instructions: '実践例を中心に読みたい',
      profile: { summary: '実践例を優先', boostTerms: ['実践'], muteTerms: ['広告'], preferredDepth: 'practical' },
      analysis: { article: { articleId: 'article', interest: 90, importance: 80, summary: 'AIの概要', reason: '関心に一致', importanceReason: '実用的' } },
      notes: [{ id: 'note', articleId: 'article', quote: '日本語の引用', body: '自分のノート', createdAt: '2026-11-07T12:01:00Z', updatedAt: '2026-11-07T12:02:00Z' }],
      exploration: 25,
      digestMinutes: 10,
      digest: { title: '今日のまとめ', overview: '全体の要約', items: [{ articleId: 'article', summary: '概要', takeaway: '覚えておくこと', minutes: 4 }], totalMinutes: 4, generatedAt: '2026-11-07T13:00:00Z', mode: 'ai' },
      storyReports: { story: { overview: '比較', developments: [{ text: '新しい動き', articleIds: ['article'] }], perspectives: [{ sourceName: '購読元', point: '視点', articleIds: ['article'] }], uncertainties: ['未確認事項'] } },
      chats: [{ id: 'chat', question: '要点は？', result: { answer: '回答', citations: [{ articleId: 'article', quote: '記事の本文' }] }, createdAt: '2026-11-07T14:00:00Z' }],
    },
    updatedAt: '2026-11-07T15:00:00Z',
  };
}

test('v2バックアップの保存・既読・好み・本文・ノート・AI引用を変更せず復元する', () => {
  const original = backup();
  const text = JSON.stringify(original, null, 2);
  const restored = parseLibraryBackup(text);
  assert.deepEqual(restored, original);
  assert.equal(JSON.stringify(original, null, 2), text);
  assert.equal(restored.reader.articles[0].content, '記事の本文と日本語の引用。😀');
  assert.deepEqual(restored.intelligence.chats[0].result.citations, [{ articleId: 'article', quote: '記事の本文' }]);
  restored.reader.saved.push('new');
  assert.deepEqual(original.reader.saved, ['article']);
});

test('不正JSONやトップレベルの参照型・プリミティブを日本語エラーで拒否する', () => {
  for (const text of ['', '{invalid', '{"version":2,}', 'null', '[]', '"backup"', '42', 'true']) {
    assert.throws(() => parseLibraryBackup(text), (error: unknown) => error instanceof Error && /[ぁ-んァ-ヶ一-龠]/u.test(error.message));
  }
});

test('未知・旧バージョンは部分復元や自動変換をせず拒否する', () => {
  for (const version of [0, 1, 3, '2', null]) {
    assert.throws(() => parseLibraryBackup(JSON.stringify({ ...backup(), version })));
  }
  assert.throws(() => parseLibraryBackup(JSON.stringify(backup().reader)));
  const oldReader = backup();
  Object.assign(oldReader.reader, { version: 2 });
  assert.throws(() => parseLibraryBackup(JSON.stringify(oldReader)));
});

test('本文や保存リスト等の型違いと欠落・未知フィールドを拒否する', () => {
  const invalid: unknown[] = [
    { ...backup(), extra: 'unexpected' },
    { ...backup(), intelligence: null },
    { ...backup(), reader: { ...backup().reader, saved: { article: true } } },
    { ...backup(), reader: { ...backup().reader, articles: [{ ...backup().reader.articles[0], content: { html: '本文' } }] } },
    { ...backup(), reader: { ...backup().reader, preferences: { ...backup().reader.preferences, diversity: 101 } } },
    { ...backup(), intelligence: { ...backup().intelligence, notes: [{ id: 'partial' }] } },
    { ...backup(), intelligence: { ...backup().intelligence, chats: [{ ...backup().intelligence.chats[0], result: { answer: '回答', citations: ['article'] } }] } },
  ];
  for (const value of invalid) assert.throws(() => parseLibraryBackup(JSON.stringify(value)));
});

test('prototype操作用のキーを任意の深さのレコードでも拒否する', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const unsafe = backup();
    unsafe.reader.preferences.topicWeights = JSON.parse(`{"${key}":1}`);
    assert.throws(() => parseLibraryBackup(JSON.stringify(unsafe)));
  }
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
});

test('compact JSONが4MiBちょうどなら完全に保持し1バイトでも超えたら拒否する', () => {
  const document = backup();
  document.intelligence.instructions = '';
  const overhead = Buffer.byteLength(JSON.stringify(document));
  document.intelligence.instructions = 'x'.repeat(MAX_LIBRARY_BYTES - overhead);
  const exact = JSON.stringify(document);
  assert.equal(Buffer.byteLength(exact), MAX_LIBRARY_BYTES);
  assert.equal(parseLibraryBackup(` \n${exact}\n `).intelligence.instructions.length, MAX_LIBRARY_BYTES - overhead);
  document.intelligence.instructions += 'x';
  assert.throws(() => parseLibraryBackup(JSON.stringify(document)), /4\s*(?:MiB|MB)/u);
});

test('文字数が上限未満でもUTF-8で4MiBを超える文書を切り捨てず拒否する', () => {
  const document = backup();
  document.intelligence.instructions = 'あ'.repeat(1_400_000);
  const text = JSON.stringify(document);
  assert.ok(text.length < MAX_LIBRARY_BYTES);
  assert.ok(Buffer.byteLength(text) > MAX_LIBRARY_BYTES);
  assert.throws(() => parseLibraryBackup(text), /4\s*(?:MiB|MB)/u);
  assert.equal(document.intelligence.instructions.length, 1_400_000);
});

test('整形用空白を含むraw textもUTF-8で16MiBを超えたら拒否する', () => {
  const text = JSON.stringify(backup());
  const rawLimit = 16 * 1024 * 1024;
  const padding = ' '.repeat(rawLimit - Buffer.byteLength(text));
  assert.deepEqual(parseLibraryBackup(text + padding), backup());
  assert.throws(() => parseLibraryBackup(text + padding + ' '), /16\s*(?:MiB|MB)/u);
  const multibyte = JSON.stringify({ ...backup(), updatedAt: 'あ'.repeat(6_000_000) });
  assert.ok(multibyte.length < rawLimit);
  assert.throws(() => parseLibraryBackup(multibyte), /16\s*(?:MiB|MB)/u);
});

// Nodeのテストから実際のReactコンポーネントを動かすため、担当TSXだけを変換する。
async function loadTransfer() {
  const componentUrl = new URL('../components/folio/library-backup-transfer.tsx', import.meta.url);
  const compiled = ts.transpileModule(readFileSync(componentUrl, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { after: [context => source => ts.visitEachChild(source, node => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return node;
      const specifier = node.moduleSpecifier.text;
      const url = specifier === '@/lib/library-backup'
        ? new URL('../lib/library-backup.ts', import.meta.url).href
        : import.meta.resolve(specifier);
      return context.factory.updateImportDeclaration(node, node.modifiers, node.importClause, context.factory.createStringLiteral(url), node.attributes);
    }, context)] },
  });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
}

async function mountTransfer(onImport: (document: SyncDocument) => void, disabled = false) {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const environment = globalThis as unknown as Record<string, unknown>;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(environment, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { LibraryBackupTransfer } = await loadTransfer();
  const container = window.document.getElementById('root')!;
  const root = createRoot(container);
  const render = async (isDisabled: boolean) => { await act(async () => { root.render(createElement(LibraryBackupTransfer, { onImport, disabled: isDisabled })); }); };
  await render(disabled);
  const buttons = () => [...container.querySelectorAll('button')];
  const restoreButton = () => buttons().find(button => button.textContent?.includes('このバックアップを読み込む'))!;
  const click = async (button: HTMLElement) => { await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })); }); };
  const choose = async (file: File) => {
    const input = container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await new Promise(resolve => setImmediate(resolve)); });
  };
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(environment, key, descriptor);
      else delete environment[key];
    }
  };
  return { container, render, buttons, restoreButton, click, choose, cleanup };
}

test('選択だけでは復元せずファイル名と件数を確認後のボタン操作で全データを渡す', async () => {
  const imported: SyncDocument[] = [];
  const view = await mountTransfer(document => imported.push(document));
  try {
    assert.equal(view.restoreButton().hasAttribute('disabled'), true);
    assert.equal(view.container.querySelector('input')?.getAttribute('accept'), '.json,application/json');
    await view.choose(new File([JSON.stringify(backup(), null, 2)], 'folio-backup.json', { type: 'application/json' }));
    assert.deepEqual(imported, []);
    assert.match(view.container.textContent!, /folio-backup\.json/u);
    for (const label of ['購読', '記事', '保存', 'ノート']) assert.match(view.container.textContent!, new RegExp(`${label}[^0-9]*1件`, 'u'));
    assert.match(view.container.textContent!, /現在.*置き換え/u);
    assert.equal(view.restoreButton().hasAttribute('disabled'), false);
    await view.click(view.restoreButton());
    assert.deepEqual(imported, [backup()]);
    assert.equal(view.restoreButton().hasAttribute('disabled'), true);
  } finally { await view.cleanup(); }
});

test('キャンセルでプレビューと入力を解除し同じファイルを選び直せる', async () => {
  const imported: SyncDocument[] = [];
  const view = await mountTransfer(document => imported.push(document));
  try {
    const file = new File([JSON.stringify(backup())], 'same.json');
    await view.choose(file);
    await view.click(view.buttons().find(button => button.textContent === 'キャンセル')!);
    assert.equal(view.container.querySelector('input')?.getAttribute('value') ?? '', '');
    assert.equal(view.container.querySelector('.opml-preview'), null);
    assert.equal(view.restoreButton().hasAttribute('disabled'), true);
    await view.choose(file);
    assert.equal(view.restoreButton().hasAttribute('disabled'), false);
    assert.deepEqual(imported, []);
  } finally { await view.cleanup(); }
});

test('エラーとdisabledの間は復元できず不正ファイルの前のプレビューも使わない', async () => {
  const imported: SyncDocument[] = [];
  const view = await mountTransfer(document => imported.push(document));
  try {
    await view.choose(new File([JSON.stringify(backup())], 'valid.json'));
    await view.render(true);
    assert.equal(view.restoreButton().hasAttribute('disabled'), true);
    await view.click(view.restoreButton());
    assert.deepEqual(imported, []);
    await view.render(false);
    await view.choose(new File(['{invalid'], 'invalid.json'));
    assert.ok(view.container.querySelector('[role="alert"]'));
    assert.equal(view.container.querySelector('.opml-preview'), null);
    assert.equal(view.restoreButton().hasAttribute('disabled'), true);
    await view.click(view.restoreButton());
    assert.deepEqual(imported, []);
  } finally { await view.cleanup(); }
});

test('遅いファイルの読み込み結果で後から選んだバックアップを上書きしない', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const imported: SyncDocument[] = [];
  const view = await mountTransfer(document => imported.push(document));
  try {
    const old = new File([JSON.stringify(backup())], 'old.json');
    Object.defineProperty(old, 'text', { value: async () => { await gate; return JSON.stringify(backup()); } });
    await view.choose(old);
    const newer = backup();
    newer.reader.saved = [];
    await view.choose(new File([JSON.stringify(newer)], 'new.json'));
    await act(async () => { release(); });
    assert.match(view.container.textContent!, /new\.json/u);
    assert.doesNotMatch(view.container.textContent!, /old\.json/u);
    await view.click(view.restoreButton());
    assert.deepEqual(imported, [newer]);
  } finally { release(); await view.cleanup(); }
});

test('AI設定付きのバックアップを復元し、aiなしの旧バックアップも読める', () => {
  const original = backup();
  assert.equal('ai' in original.intelligence, false);
  assert.deepEqual(parseLibraryBackup(JSON.stringify(original)), original);
  original.intelligence.ai = { provider: 'openrouter', models: { openrouter: 'openai/gpt-6-luna' }, efforts: { openrouter: 'low' } };
  assert.deepEqual(parseLibraryBackup(JSON.stringify(original)), original);
});
