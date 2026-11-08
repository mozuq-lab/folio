import handler from 'vinext/server/fetch-handler';
import { authenticateAccessRequest, type AccessEnvironment } from '../lib/cloudflare-access.ts';
import { authenticateDevRequest } from '../lib/auth/dev.ts';
import { createWorkerFetch } from './handler.ts';

const worker = {
  // Development identity is loopback-only and removed from production builds
  // because import.meta.env.DEV is statically false there.
  fetch: createWorkerFetch<Cloudflare.Env & AccessEnvironment>({
    handler: (request, env, ctx) => handler.fetch(request, env, ctx),
    authenticate: import.meta.env.DEV ? authenticateDevRequest : authenticateAccessRequest,
  }),
};

export default worker;
