import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { AccessAuthError, authenticateAccessRequest, type AccessEnvironment } from '../lib/cloudflare-access.ts';

const issuer = 'https://folio-test.cloudflareaccess.com';
const environment: AccessEnvironment = {
  FOLIO_ACCESS_TEAM_DOMAIN: issuer,
  FOLIO_ACCESS_AUD: 'folio-application-audience',
  FOLIO_ALLOWED_EMAILS: 'owner@example.com',
};
const keys = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(keys.publicKey), alg: 'RS256', use: 'sig', kid: 'test-signing-key' };
const keySet = { keys: [publicJwk] };
const keyResolver = createLocalJWKSet(keySet);

function claims(overrides: JWTPayload = {}): JWTPayload {
  return {
    iss: issuer,
    aud: environment.FOLIO_ACCESS_AUD,
    exp: Math.floor(Date.now() / 1000) + 300,
    sub: 'user-123',
    email: 'owner@example.com',
    type: 'app',
    ...overrides,
  };
}

async function token(payload = claims(), options: { algorithm?: string; kid?: string; privateKey?: CryptoKey } = {}): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: options.algorithm ?? 'RS256', kid: options.kid ?? 'test-signing-key' })
    .sign(options.privateKey ?? keys.privateKey);
}

function request(jwt?: string, headers: HeadersInit = {}): Request {
  const allHeaders = new Headers(headers);
  if (jwt !== undefined) allHeaders.set('Cf-Access-Jwt-Assertion', jwt);
  return new Request('https://folio.example/api/library', { headers: allHeaders });
}

function authError(status: number): (error: unknown) => boolean {
  return error => error instanceof AccessAuthError && error.status === status;
}

test('署名済み本人情報から利用者を返し、偽装ヘッダーを参照せず要求を改変しない', async () => {
  const jwt = await token(claims({ name: '山田 太郎' }));
  const original = new Request('https://folio.example/api/library?revision=2', {
    method: 'POST',
    body: '{"saved":["article-1"]}',
    headers: {
      'Cf-Access-Jwt-Assertion': jwt,
      'OAI-Authenticated-User-Id': 'attacker',
      'oai-authenticated-user-email': 'attacker@example.com',
      'oai-authenticated-user-full-name': 'Attacker',
      'content-type': 'application/json',
    },
  });
  const user = await authenticateAccessRequest(original, environment, { keyResolver });
  assert.deepEqual(user, { id: 'cloudflare-access:user-123', email: 'owner@example.com', displayName: '山田 太郎' });
  assert.equal(original.headers.get('oai-authenticated-user-id'), 'attacker');
  assert.equal(await original.text(), '{"saved":["article-1"]}');
});

test('JWT に名前がなければ表示名はメールになり、偽装された名前を使わない', async () => {
  for (const name of [undefined, '', '   ']) {
    const user = await authenticateAccessRequest(request(await token(claims(name === undefined ? {} : { name })), {
      'oai-authenticated-user-full-name': 'forged',
      'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
    }), environment, { keyResolver });
    assert.equal(user.displayName, 'owner@example.com');
    assert.equal(user.id, 'cloudflare-access:user-123');
  }
});

test('メールは小文字で完全一致し、許可リストのカンマと周囲空白を処理する', async () => {
  const authenticated = await authenticateAccessRequest(request(await token(claims({ email: 'OWNER@EXAMPLE.COM' }))), {
    ...environment,
    FOLIO_ACCESS_TEAM_DOMAIN: `${issuer}/`,
    FOLIO_ALLOWED_EMAILS: ' another@example.com , Owner@Example.COM ',
  }, { keyResolver });
  assert.equal(authenticated.email, 'owner@example.com');
});

test('JWT ヘッダーがなければ偽装本人情報や認証 cookie だけでは通過しない', async () => {
  await assert.rejects(authenticateAccessRequest(request(undefined, {
    'oai-authenticated-user-id': 'owner',
    'oai-authenticated-user-email': 'owner@example.com',
    'cookie': `CF_Authorization=${await token()}`,
  }), environment, { keyResolver }), authError(403));
});

test('破損した JWT、署名の差し替え、未知の署名鍵を拒否する', async () => {
  const signed = await token();
  const parts = signed.split('.');
  parts[1] = Buffer.from(JSON.stringify(claims({ sub: 'changed-subject' }))).toString('base64url');
  const otherKeys = await generateKeyPair('RS256');
  for (const bad of ['not-a-jwt', parts.join('.'), await token(claims(), { kid: 'untrusted-key' }), await token(claims(), { privateKey: otherKeys.privateKey })]) {
    await assert.rejects(authenticateAccessRequest(request(bad), environment, { keyResolver }), authError(403));
  }
});

test('RS256 以外の署名方式を拒否する', async () => {
  const hmacToken = await new SignJWT(claims()).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('test-only-secret-at-least-32-bytes'));
  const ecKeys = await generateKeyPair('ES256');
  const ecToken = await token(claims(), { algorithm: 'ES256', privateKey: ecKeys.privateKey });
  const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.`;
  for (const bad of [hmacToken, ecToken, unsigned]) {
    await assert.rejects(authenticateAccessRequest(request(bad), environment, { keyResolver }), authError(403));
  }
});

test('期限切れ、未発効、exp 欠落・不正を拒否する', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const overrides of [{ exp: now - 1 }, { nbf: now + 300 }, { exp: undefined }, { exp: 'later' }, { exp: null }]) {
    await assert.rejects(authenticateAccessRequest(request(await token(claims(overrides as JWTPayload))), environment, { keyResolver }), authError(403));
  }
});

test('issuer と audience の欠落・不一致を拒否する', async () => {
  for (const overrides of [{ iss: 'https://attacker.example' }, { iss: undefined }, { aud: 'another-application' }, { aud: undefined }]) {
    await assert.rejects(authenticateAccessRequest(request(await token(claims(overrides))), environment, { keyResolver }), authError(403));
  }
});

test('audience の配列には設定されたアプリの audience が必要', async () => {
  const authenticated = await authenticateAccessRequest(request(await token(claims({ aud: ['other', 'folio-application-audience'] }))), environment, { keyResolver });
  assert.equal(authenticated.id, 'cloudflare-access:user-123');
  await assert.rejects(authenticateAccessRequest(request(await token(claims({ aud: ['other', 'unrelated'] }))), environment, { keyResolver }), authError(403));
});

test('sub と email の欠落、空文字、誤った型、ヘッダー制御文字を拒否する', async () => {
  const invalid = [
    { sub: undefined }, { sub: '' }, { sub: ' ' }, { sub: 123 }, { sub: 'user\r\nforged: true' }, { sub: 'user-123\n' },
    { email: undefined }, { email: '' }, { email: 123 }, { email: 'owner@example.com\r\n' },
  ];
  for (const overrides of invalid) {
    await assert.rejects(authenticateAccessRequest(request(await token(claims(overrides as JWTPayload))), environment, { keyResolver }), authError(403));
  }
});

test('別のメール、サフィックス一致、空白付きメールを許可しない', async () => {
  for (const email of ['other@example.com', 'owner@example.com.attacker.test', 'prefix-owner@example.com', ' owner@example.com']) {
    await assert.rejects(authenticateAccessRequest(request(await token(claims({ email }))), environment, { keyResolver }), authError(403));
  }
});

test('サービス token と global session token は本人として受理しない', async () => {
  for (const overrides of [
    { sub: '', email: undefined, common_name: 'service.access' },
    { common_name: 'service.access' },
    { service_token_id: 'service-client-id' },
    { service_token_status: true },
    { type: 'org' },
    { type: undefined },
  ]) {
    await assert.rejects(authenticateAccessRequest(request(await token(claims(overrides))), environment, { keyResolver }), authError(403));
  }
});

test('必須設定の欠落と不正な audience・メール許可設定は 503 で停止する', async () => {
  const validRequest = request(await token());
  const invalid: AccessEnvironment[] = [
    {},
    { ...environment, FOLIO_ACCESS_TEAM_DOMAIN: undefined },
    { ...environment, FOLIO_ACCESS_AUD: undefined },
    { ...environment, FOLIO_ACCESS_AUD: '' },
    { ...environment, FOLIO_ACCESS_AUD: ' ' },
    { ...environment, FOLIO_ACCESS_AUD: 'aud\nience' },
    { ...environment, FOLIO_ACCESS_AUD: 'audience\n' },
    { ...environment, FOLIO_ALLOWED_EMAILS: undefined },
    { ...environment, FOLIO_ALLOWED_EMAILS: '' },
    { ...environment, FOLIO_ALLOWED_EMAILS: '*' },
    { ...environment, FOLIO_ALLOWED_EMAILS: '*@example.com' },
    { ...environment, FOLIO_ALLOWED_EMAILS: 'owner@example.com,' },
    { ...environment, FOLIO_ALLOWED_EMAILS: 'owner@example.com,invalid' },
  ];
  for (const env of invalid) {
    await assert.rejects(authenticateAccessRequest(validRequest, env, { keyResolver }), authError(503));
  }
  await assert.rejects(authenticateAccessRequest(request(), {}, { keyResolver }), authError(503));
});

test('team domain は Cloudflare Access の HTTPS root origin だけを許可する', async () => {
  for (const domain of [
    '', 'https://attacker.example', 'http://folio-test.cloudflareaccess.com',
    'https://cloudflareaccess.com', 'https://sub.folio-test.cloudflareaccess.com',
    'https://folio-test.cloudflareaccess.com.attacker.example',
    'https://user:password@folio-test.cloudflareaccess.com',
    'https://@folio-test.cloudflareaccess.com',
    'https://folio-test.cloudflareaccess.com:443', 'https://folio-test.cloudflareaccess.com:8443',
    'https://folio-test.cloudflareaccess.com/cdn-cgi/access/certs',
    'https://folio-test.cloudflareaccess.com/./', 'https://folio-test.cloudflareaccess.com/../',
    'https://folio-test.cloudflareaccess.com?jwks=attacker', 'https://folio-test.cloudflareaccess.com?',
    'https://folio-test.cloudflareaccess.com#attacker', 'https://folio-test.cloudflareaccess.com#',
    'https://%66olio-test.cloudflareaccess.com', 'https://folio-test.cloudflareaccess.com\\@attacker.example',
    'https://-folio.cloudflareaccess.com', 'https://folio-.cloudflareaccess.com',
    'https://folio_test.cloudflareaccess.com', ' https://folio-test.cloudflareaccess.com',
    'https://folio-test.cloudflareaccess.com\n', 'https://folio-test.cloudflareaccess.com\r\n',
  ]) {
    await assert.rejects(authenticateAccessRequest(request(await token()), {
      ...environment, FOLIO_ACCESS_TEAM_DOMAIN: domain,
    }, { keyResolver }), authError(503), domain);
  }
});

test('検証エラーには JWT、cookie、署名鍵取得のエラー詳細を含めない', async () => {
  const jwt = await token();
  await assert.rejects(authenticateAccessRequest(request(jwt, { cookie: 'opaque-session=private-session' }), environment, {
    keyResolver: async () => { throw new Error(`private-resolver-detail ${jwt} private-session`); },
  }), (error: unknown) => {
    assert.ok(error instanceof AccessAuthError);
    assert.equal(error.status, 403);
    assert.equal(String(error).includes(jwt), false);
    assert.equal(String(error).includes('private-session'), false);
    assert.equal(String(error).includes('private-resolver-detail'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('公開鍵は JWT の issuer ではなく設定した origin から取得し再利用する', async t => {
  const configuredIssuer = 'https://remote-jwks-test.cloudflareaccess.com';
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    assert.equal(init?.redirect, 'manual');
    return Response.json(keySet);
  });
  const env = { ...environment, FOLIO_ACCESS_TEAM_DOMAIN: configuredIssuer };
  await assert.rejects(authenticateAccessRequest(request(await token(claims({ iss: 'https://attacker.example' }))), env), authError(403));
  const authenticated = await authenticateAccessRequest(request(await token(claims({ iss: configuredIssuer }))), env);
  assert.equal(authenticated.id, 'cloudflare-access:user-123');
  assert.deepEqual(urls, ['https://remote-jwks-test.cloudflareaccess.com/cdn-cgi/access/certs']);
});

test('異なる設定の公開鍵キャッシュは無制限に保持しない', async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json(keySet);
  });
  const authenticateFor = async (name: string) => {
    const teamDomain = `https://${name}.cloudflareaccess.com`;
    return authenticateAccessRequest(request(await token(claims({ iss: teamDomain }))), { ...environment, FOLIO_ACCESS_TEAM_DOMAIN: teamDomain });
  };
  await authenticateFor('cache-original');
  await authenticateFor('cache-original');
  assert.equal(urls.length, 1);
  for (let i = 0; i < 20; i++) await authenticateFor(`cache-other-${i}`);
  await authenticateFor('cache-original');
  assert.equal(urls.filter(url => url === 'https://cache-original.cloudflareaccess.com/cdn-cgi/access/certs').length, 2);
});

test('公開鍵取得は timeout で打ち切り、内部エラーを公開しない', async t => {
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error('timeout-was-not-applied')), 6500);
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        clearTimeout(fallback);
        reject(new Error('private-network-detail'));
      }, { once: true });
    });
  });
  const teamDomain = 'https://timeout-test.cloudflareaccess.com';
  await assert.rejects(authenticateAccessRequest(request(await token(claims({ iss: teamDomain }))), { ...environment, FOLIO_ACCESS_TEAM_DOMAIN: teamDomain }), (error: unknown) => {
    assert.ok(error instanceof AccessAuthError);
    assert.equal(error.status, 403);
    assert.equal(String(error).includes('private-network-detail'), false);
    return true;
  });
  assert.equal(aborted, true);
});
