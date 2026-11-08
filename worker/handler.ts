import { runWithUser, type AuthUser } from '../lib/auth/context.ts';
import { AccessAuthError } from '../lib/cloudflare-access.ts';

export type WorkerFetchDeps<Env> = {
  handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  authenticate: (request: Request, env: Env) => Promise<AuthUser> | AuthUser;
};

const DENIED_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export function createWorkerFetch<Env>(deps: WorkerFetchDeps<Env>): (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> {
  return async (request, env, ctx) => {
    let user: AuthUser;
    try { user = await deps.authenticate(request, env); }
    catch (error) {
      const status = error instanceof AccessAuthError ? error.status : 403;
      return new Response(status === 503 ? 'Cloudflare Accessの設定を完了してください。' : 'Folioへのログインが必要です。', { status, headers: DENIED_HEADERS });
    }
    return runWithUser(user, () => deps.handler(request, env, ctx));
  };
}
