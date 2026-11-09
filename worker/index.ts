import handler from 'vinext/server/fetch-handler';
import { authenticateAccessRequest, type AccessEnvironment } from '../lib/cloudflare-access.ts';
import { authenticateDevRequest } from '../lib/auth/dev.ts';
import { parseAllowedEmails, runScheduledFetch } from '../lib/backlog/scheduled.ts';
import { createWorkerFetch, fetchStaticAsset } from './handler.ts';

const worker = {
  // Development identity is loopback-only and removed from production builds
  // because import.meta.env.DEV is statically false there.
  fetch: createWorkerFetch<Cloudflare.Env & AccessEnvironment>({
    handler: (request, env, ctx) => handler.fetch(request, env, ctx),
    authenticate: import.meta.env.DEV ? authenticateDevRequest : authenticateAccessRequest,
    serveAsset: (request, env) => fetchStaticAsset(request, env.ASSETS),
  }),
  // 定期取得はCronからだけ起動する。外部から呼べるHTTPエンドポイントは作らない。
  scheduled(controller: ScheduledController, env: Cloudflare.Env & AccessEnvironment, ctx: ExecutionContext) {
    if (!env.DB) return;
    ctx.waitUntil(runScheduledFetch({ db: env.DB, now: new Date(controller.scheduledTime), allowedEmails: parseAllowedEmails(env.FOLIO_ALLOWED_EMAILS) }));
  },
};

export default worker;
