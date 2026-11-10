import { getCurrentUser } from '../../../lib/auth/context.ts';
import { handleFavicon } from '../../../lib/favicon.ts';

// サイトのファビコン。サイトごとにCache APIへ保存し、利用者のあいだで共有する（ファビコンは公開情報）。
export async function GET(request: Request): Promise<Response> {
  if (!getCurrentUser()) return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const cache = typeof caches !== 'undefined' && 'default' in caches ? (caches as unknown as { default: Cache }).default : undefined;
  return handleFavicon(request, { cache });
}
