import { env } from 'cloudflare:workers';
import { getCurrentUser } from '../../../../lib/auth/context.ts';
import { NO_STORE_HEADERS } from '../../../../lib/http.ts';
import { handleRefreshFeed } from '../../../../lib/backlog/api.ts';

export async function POST(request:Request):Promise<Response> {
  const user=getCurrentUser();
  if(!user) return Response.json({error:'ログインしてください。'},{status:401,headers:NO_STORE_HEADERS});
  if(!env.DB) return Response.json({error:'クラウド同期が利用できません。しばらくしてからお試しください。'},{status:503,headers:NO_STORE_HEADERS});
  return handleRefreshFeed(request,{db:env.DB,user});
}
