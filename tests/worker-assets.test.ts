import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessAuthError } from '../lib/cloudflare-access.ts';
import { createWorkerFetch, fetchStaticAsset } from '../worker/handler.ts';

const owner = { id: 'cloudflare-access:owner', email: 'owner@example.com', displayName: 'Owner' };
const ctx = {} as ExecutionContext;

function assetStore(files: Record<string, string>) {
  const requested: string[] = [];
  return {
    requested,
    fetch: async (request: Request) => {
      const { pathname } = new URL(request.url);
      requested.push(pathname);
      return pathname in files ? new Response(files[pathname], { headers: { 'Content-Type': 'text/css' } }) : new Response('not found', { status: 404 });
    },
  };
}

type Env = { ASSETS?: ReturnType<typeof assetStore> };

function worker(authenticate: () => typeof owner = () => owner) {
  const calls: string[] = [];
  const fetch = createWorkerFetch<Env>({
    handler: async request => { calls.push(new URL(request.url).pathname); return new Response('app'); },
    authenticate,
    serveAsset: (request, env) => fetchStaticAsset(request, env.ASSETS),
  });
  return { fetch, calls };
}

test('ログイン済みのCSS要求は静的ファイルから返し、アプリ本体を呼ばない', async () => {
  const assets = assetStore({ '/_next/static/css/page.css': 'body{}' });
  const { fetch, calls } = worker();
  const response = await fetch(new Request('https://folio.example/_next/static/css/page.css'), { ASSETS: assets }, ctx);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'body{}');
  assert.deepEqual(calls, []);
});

test('静的ファイルに無いパスはアプリ本体へ渡す', async () => {
  const assets = assetStore({});
  const { fetch, calls } = worker();
  const response = await fetch(new Request('https://folio.example/'), { ASSETS: assets }, ctx);
  assert.equal(await response.text(), 'app');
  assert.deepEqual(calls, ['/']);
  assert.deepEqual(assets.requested, ['/']);
});

test('未ログインの要求では静的ファイルを参照しない', async () => {
  const assets = assetStore({ '/_next/static/css/page.css': 'body{}' });
  const { fetch, calls } = worker(() => { throw new AccessAuthError(403); });
  const response = await fetch(new Request('https://folio.example/_next/static/css/page.css'), { ASSETS: assets }, ctx);
  assert.equal(response.status, 403);
  assert.deepEqual(assets.requested, []);
  assert.deepEqual(calls, []);
});

test('GET・HEAD以外は静的ファイルを参照せずアプリ本体へ渡す', async () => {
  const assets = assetStore({ '/api/library': 'never' });
  const { fetch, calls } = worker();
  await fetch(new Request('https://folio.example/api/library', { method: 'PUT', body: '{}' }), { ASSETS: assets }, ctx);
  assert.deepEqual(assets.requested, []);
  assert.deepEqual(calls, ['/api/library']);
});

test('静的ファイルの置き場が無い環境（開発サーバー）ではアプリ本体へ渡す', async () => {
  const { fetch, calls } = worker();
  assert.equal(await (await fetch(new Request('https://folio.example/_next/static/css/page.css'), {}, ctx)).text(), 'app');
  assert.deepEqual(calls, ['/_next/static/css/page.css']);
});
