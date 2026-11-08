import { AccessAuthError } from '../cloudflare-access.ts';
import type { AuthUser } from './context.ts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Local development only: the Worker entry selects this solely when
// import.meta.env.DEV is true, so production builds never include it.
export function authenticateDevRequest(request: Request): AuthUser {
  if (!LOOPBACK_HOSTS.has(new URL(request.url).hostname)) throw new AccessAuthError(403);
  return { id: 'dev:local', email: 'dev@localhost', displayName: '開発ユーザー' };
}
