import { env } from 'cloudflare:workers';
import { getCurrentUser } from '../../../lib/auth/context.ts';
import { BodyTooLargeError, NO_STORE_HEADERS, isSameOrigin, readLimitedText } from '../../../lib/http.ts';
import { getCloudLibrary, putCloudLibrary, LibraryConflictError, LibraryValidationError, MAX_LIBRARY_REQUEST_BYTES } from '../../../lib/cloud-library.ts';

const headers=NO_STORE_HEADERS;
const respond=(value:unknown,status=200)=>Response.json(value,{status,headers});

export async function GET():Promise<Response> {
  const user=getCurrentUser();
  if(!user) return respond({error:'ログインしてください。'},401);
  if(!env.DB) return respond({error:'クラウド同期が利用できません。しばらくしてからお試しください。',ownerId:user.id,userName:user.displayName},503);
  try { return respond({...await getCloudLibrary(env.DB,user.id),userName:user.displayName}); }
  catch { return respond({error:'クラウドのデータを読み込めませんでした。',ownerId:user.id},500); }
}

class PayloadTooLargeError extends Error {}
async function readPayload(request:Request):Promise<unknown> {
  if(!request.body) throw new LibraryValidationError();
  try { return JSON.parse(await readLimitedText(request.body,request.headers.get('content-length'),MAX_LIBRARY_REQUEST_BYTES)); }
  catch(error) { throw error instanceof BodyTooLargeError?new PayloadTooLargeError():error; }
}
export async function PUT(request:Request):Promise<Response> {
  if(!isSameOrigin(request)) return respond({error:'同じサイトから同期してください。'},403);
  const user=getCurrentUser();
  if(!user) return respond({error:'ログインしてください。'},401);
  if(!env.DB) return respond({error:'クラウド同期が利用できません。しばらくしてからお試しください。',ownerId:user.id,userName:user.displayName},503);
  let payload:unknown;
  try { payload=await readPayload(request); }
  catch(error) { return respond({error:error instanceof PayloadTooLargeError?'同期データは4MB以下にしてください。':'同期データを読み込めませんでした。'},error instanceof PayloadTooLargeError?413:400); }
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['document','baseRevision','expectedOwnerId'].includes(key))) return respond({error:'同期データの形式が正しくありません。'},400);
  const input=payload as {document?:unknown;baseRevision?:unknown;expectedOwnerId?:unknown};
  // Validation is performed inside the library as well; user ID is never client input.
  if(typeof input.baseRevision!=='number') return respond({error:'同期データのrevisionが正しくありません。'},400);
  if(typeof input.expectedOwnerId!=='string'||!input.expectedOwnerId) return respond({error:'同期するアカウントを確認できません。ページを再読込してください。'},400);
  try {
    const result=await putCloudLibrary(env.DB,user.id,input.document as Parameters<typeof putCloudLibrary>[2],input.baseRevision,input.expectedOwnerId);
    return respond({...result,userName:user.displayName});
  } catch(error) {
    if(error instanceof LibraryConflictError) return respond({error:error.message,current:{...error.current,userName:user.displayName}},409);
    if(error instanceof LibraryValidationError) return respond({error:error.message},400);
    return respond({error:'クラウドに保存できませんでした。もう一度お試しください。'},500);
  }
}
