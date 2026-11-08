import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthUser } from './auth/context.ts';

export type AccessEnvironment = {
  FOLIO_ACCESS_TEAM_DOMAIN?: string;
  FOLIO_ACCESS_AUD?: string;
  FOLIO_ALLOWED_EMAILS?: string;
};

export class AccessAuthError extends Error {
  status: number;

  constructor(status: number) {
    super(status === 503 ? 'Cloudflare Access の設定を確認してください。' : 'アクセスが許可されていません。');
    this.name = 'AccessAuthError';
    this.status = status;
  }
}

const TEAM_DOMAIN_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com\/?$/;
const HEADER_SAFE_VALUE = /^[\x21-\x7e]+$/;
const EMAIL_PATTERN = /^[^\s@*,<>]+@[^\s@*,<>]+\.[^\s@*,<>]+$/;
const MAX_JWKS_RESOLVERS = 4;
const jwksResolvers = new Map<string, JWTVerifyGetKey>();

function accessConfiguration(env: AccessEnvironment): { issuer: string; audience: string; allowedEmails: Set<string> } {
  const teamDomain = env.FOLIO_ACCESS_TEAM_DOMAIN;
  const audience = env.FOLIO_ACCESS_AUD;
  const emails = env.FOLIO_ALLOWED_EMAILS;
  if (typeof teamDomain !== 'string' || !TEAM_DOMAIN_PATTERN.test(teamDomain)
    || typeof audience !== 'string' || !HEADER_SAFE_VALUE.test(audience)
    || typeof emails !== 'string') {
    throw new AccessAuthError(503);
  }

  const allowedEmails = emails.split(',').map(email => email.trim().toLowerCase());
  if (allowedEmails.some(email => !HEADER_SAFE_VALUE.test(email) || !EMAIL_PATTERN.test(email))) {
    throw new AccessAuthError(503);
  }
  return { issuer: new URL(teamDomain).origin, audience, allowedEmails: new Set(allowedEmails) };
}

function remoteKeyResolver(issuer: string): JWTVerifyGetKey {
  let resolver = jwksResolvers.get(issuer);
  if (resolver) {
    jwksResolvers.delete(issuer);
  } else {
    // 公開鍵の取得先には検証済みの設定だけを使用する。
    resolver = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 600000,
    });
  }
  jwksResolvers.set(issuer, resolver);
  if (jwksResolvers.size > MAX_JWKS_RESOLVERS) {
    const oldest = jwksResolvers.keys().next().value;
    if (oldest !== undefined) jwksResolvers.delete(oldest);
  }
  return resolver;
}

export async function authenticateAccessRequest(
  request: Request,
  env: AccessEnvironment,
  options: { keyResolver?: JWTVerifyGetKey } = {},
): Promise<AuthUser> {
  const { issuer, audience, allowedEmails } = accessConfiguration(env);
  try {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) throw new AccessAuthError(403);

    const { payload } = await jwtVerify(token, options.keyResolver ?? remoteKeyResolver(issuer), {
      algorithms: ['RS256'],
      issuer,
      audience,
      requiredClaims: ['exp', 'sub', 'email', 'type'],
    });
    if (payload.type !== 'app'
      || Object.hasOwn(payload, 'common_name')
      || Object.hasOwn(payload, 'service_token_id')
      || payload.service_token_status === true
      || typeof payload.sub !== 'string' || !HEADER_SAFE_VALUE.test(payload.sub)
      || typeof payload.email !== 'string') {
      throw new AccessAuthError(403);
    }

    const email = payload.email.toLowerCase();
    if (!allowedEmails.has(email)) throw new AccessAuthError(403);

    const displayName = typeof payload.name === 'string' && payload.name.trim() ? payload.name : email;
    return { id: `cloudflare-access:${payload.sub}`, email, displayName };
  } catch {
    // 検証・通信エラーには認証情報が含まれ得るため、その詳細や cause を外に出さない。
    throw new AccessAuthError(403);
  }
}
