import { env } from 'cloudflare:workers';
import { getCurrentUser } from '../../../lib/auth/context.ts';
import { BodyTooLargeError, NO_STORE_HEADERS, isSameOrigin, readLimitedBytes } from '../../../lib/http.ts';
import { AIError, runAI, validateRequest } from '../../../lib/ai.ts';
import { createProvider, providerStatuses, resolveSelection } from '../../../lib/ai/registry.ts';

const headers = NO_STORE_HEADERS;
const requests = new Map<string, { count:number; resetsAt:number }>();
function failure(error:unknown):Response {
  return Response.json({error:error instanceof AIError?error.message:'AIの処理に失敗しました。時間をおいてお試しください。',code:error instanceof AIError?error.code:'internal_error'},{status:error instanceof AIError?error.status:500,headers});
}
function rateLimit(userId:string):void {
  const now=Date.now();
  for(const[key,value]of requests)if(value.resetsAt<=now)requests.delete(key);
  const entry=requests.get(userId);
  if(entry&&entry.count>=6)throw new AIError(429,'rate_limited','AIは1分に6回まで利用できます。少し待ってからお試しください。');
  if(entry)entry.count++;
  else{
    if(requests.size>=1000)throw new AIError(429,'rate_limited','AIの利用が集中しています。少し待ってからお試しください。');
    requests.set(userId,{count:1,resetsAt:now+60_000});
  }
}
async function payload(request:Request):Promise<unknown>{
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')??''))throw new AIError(415,'invalid_content_type','JSON形式で送信してください。');
  const max=2*1024*1024;
  if(!request.body)throw new AIError(400,'invalid_request','AIへの送信内容が空です。');
  let text:string;
  try{text=new TextDecoder().decode(await readLimitedBytes(request.body,request.headers.get('content-length'),max));}
  catch(error){throw error instanceof BodyTooLargeError?new AIError(413,'request_too_large','送信内容が2MBを超えています。記事やノートを減らしてください。'):error;}
  try{return JSON.parse(text);}catch{throw new AIError(400,'invalid_request','JSONの形式を確認してください。');}
}
export async function GET(request:Request):Promise<Response>{
  try{
    if(!isSameOrigin(request))throw new AIError(403,'cross_origin','同じサイトからAIを利用してください。');
    if(!getCurrentUser())throw new AIError(401,'unauthorized','AIの利用にはログインが必要です。');
    return Response.json({providers:providerStatuses(env,{dev:import.meta.env.DEV})},{headers});
  }catch(error){return failure(error);}
}
export async function POST(request:Request):Promise<Response>{
  try{
    if(!isSameOrigin(request))throw new AIError(403,'cross_origin','同じサイトからAIを利用してください。');
    const user=getCurrentUser();
    if(!user)throw new AIError(401,'unauthorized','AIの利用にはログインが必要です。');
    const value=validateRequest(await payload(request));
    const selection=resolveSelection(value,providerStatuses(env,{dev:import.meta.env.DEV}));
    if(!selection.status.available)throw new AIError(503,'not_configured',`${selection.status.label}は使えません（${selection.status.reason}）。設定画面で別の提供元を選んでください。`);
    rateLimit(user.id);
    return Response.json(await runAI(value,{provider:createProvider(selection.provider,env),model:selection.model,effort:selection.effort,log:entry=>console.warn(entry)}),{headers});
  }catch(error){return failure(error);}
}
