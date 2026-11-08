import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentUser, runWithUser, type AuthUser } from '../lib/auth/context.ts';
import { authenticateDevRequest } from '../lib/auth/dev.ts';
import { AccessAuthError } from '../lib/cloudflare-access.ts';
import { createWorkerFetch } from '../worker/handler.ts';

const alice: AuthUser = { id: 'cloudflare-access:alice', email: 'alice@example.com', displayName: 'Alice' };
const bob: AuthUser = { id: 'cloudflare-access:bob', email: 'bob@example.com', displayName: 'Bob' };
const ctx = {} as ExecutionContext;
const env = {};

test('getCurrentUser は runWithUser の外では null、中では渡した利用者を返す', async () => {
  assert.equal(getCurrentUser(), null);
  const seen = await runWithUser(alice, async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    return getCurrentUser();
  });
  assert.deepEqual(seen, alice);
  assert.equal(getCurrentUser(), null);
});

test('並行する runWithUser は互いの利用者を見ない', async () => {
  const observe = (user: AuthUser, delay: number) => runWithUser(user, async () => {
    const before = getCurrentUser()?.id;
    await new Promise(resolve => setTimeout(resolve, delay));
    return [before, getCurrentUser()?.id];
  });
  const [a, b] = await Promise.all([observe(alice, 10), observe(bob, 1)]);
  assert.deepEqual(a, [alice.id, alice.id]);
  assert.deepEqual(b, [bob.id, bob.id]);
});

test('createWorkerFetch は認証失敗時に 403 を返し、handler を呼ばない', async () => {
  let called = false;
  const fetch = createWorkerFetch({
    handler: async () => { called = true; return new Response('app'); },
    authenticate: () => { throw new AccessAuthError(403); },
  });
  const response = await fetch(new Request('https://folio.example/api/library', {
    headers: { 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'owner@example.com' },
  }), env, ctx);
  assert.equal(response.status, 403);
  assert.equal(await response.text(), 'Folioへのログインが必要です。');
  assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(called, false);
});

test('createWorkerFetch は設定不備の 503 と想定外の例外の 403 を区別する', async () => {
  const misconfigured = createWorkerFetch({
    handler: async () => new Response('app'),
    authenticate: async () => { throw new AccessAuthError(503); },
  });
  const response = await misconfigured(new Request('https://folio.example/'), env, ctx);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Cloudflare Accessの設定を完了してください。');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');

  const unexpected = createWorkerFetch({
    handler: async () => new Response('app'),
    authenticate: async () => { throw new Error('private detail'); },
  });
  const failed = await unexpected(new Request('https://folio.example/'), env, ctx);
  assert.equal(failed.status, 403);
  assert.equal((await failed.text()).includes('private detail'), false);
});

test('createWorkerFetch は偽装ヘッダーではなく認証結果を handler 内の利用者にし、要求を改変しない', async () => {
  let seen: AuthUser | null = null;
  let received: Request | null = null;
  const original = new Request('https://folio.example/api/library', {
    headers: { 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'attacker@example.com' },
  });
  const fetch = createWorkerFetch({
    handler: async request => { seen = getCurrentUser(); received = request; return new Response('ok'); },
    authenticate: async () => alice,
  });
  const response = await fetch(original, env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(seen, alice);
  assert.equal((seen as AuthUser | null)?.id, 'cloudflare-access:alice');
  assert.equal(received, original);
  assert.equal(getCurrentUser(), null);
});

test('authenticateDevRequest は loopback だけに開発用利用者を割り当てる', () => {
  const developer = { id: 'dev:local', email: 'dev@localhost', displayName: '開発ユーザー' };
  for (const url of ['http://127.0.0.1:5173/', 'http://localhost:5173/api/library', 'http://[::1]:5173/']) {
    assert.deepEqual(authenticateDevRequest(new Request(url)), developer, url);
  }
  for (const url of ['https://folio.example/', 'http://127.0.0.1.attacker.example/', 'http://localhost.attacker.example/', 'http://0.0.0.0:5173/']) {
    assert.throws(() => authenticateDevRequest(new Request(url)), (error: unknown) => error instanceof AccessAuthError && error.status === 403, url);
  }
});
