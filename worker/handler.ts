import { runWithUser, type AuthUser } from '../lib/auth/context.ts';
import { AccessAuthError } from '../lib/cloudflare-access.ts';

export type AssetFetcher = { fetch(request: Request): Promise<Response> };

export type WorkerFetchDeps<Env> = {
  handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  authenticate: (request: Request, env: Env) => Promise<AuthUser> | AuthUser;
  /** Returns a built static file for the request, or null to fall through to the app. */
  serveAsset?: (request: Request, env: Env) => Promise<Response | null>;
};

const DENIED_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

/**
 * Production routes every request through the Worker first (`run_worker_first`) so
 * static files stay behind Access. vinext expects the platform to have served them
 * already and answers 404 for build assets, so serve them from the ASSETS binding here.
 */
export async function fetchStaticAsset(request: Request, assets: AssetFetcher | undefined): Promise<Response | null> {
  if (!assets || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  const response = await assets.fetch(request);
  if (response.status !== 404) return response;
  await response.body?.cancel();
  return null;
}

export function createWorkerFetch<Env>(deps: WorkerFetchDeps<Env>): (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> {
  return async (request, env, ctx) => {
    let user: AuthUser;
    try { user = await deps.authenticate(request, env); }
    catch (error) {
      const status = error instanceof AccessAuthError ? error.status : 403;
      return new Response(status === 503 ? 'Cloudflare Accessの設定を完了してください。' : 'Folioへのログインが必要です。', { status, headers: DENIED_HEADERS });
    }
    const asset = await deps.serveAsset?.(request, env);
    if (asset) return asset;
    return runWithUser(user, () => deps.handler(request, env, ctx));
  };
}
