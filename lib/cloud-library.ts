import { z } from 'zod';
import { EFFORTS, MODEL_ID_PATTERN, PROVIDER_IDS } from './ai/types.ts';
import type { CloudLibrary, SyncDocument } from './intelligence-types.ts';
import { MAX_EVER_SAVED } from './saved-history.ts';

export const MAX_LIBRARY_BYTES = 4 * 1024 * 1024;
const string = z.string();
const strings = z.array(string);
const finite = z.number().finite();
const score = finite.min(0).max(100);
export const articleSchema = z.object({ id:string,title:string,description:string,url:string,image:string.optional(),sourceId:string,sourceName:string,publishedAt:string,tags:strings,readingMinutes:finite.min(0),isSample:z.boolean().optional(),content:string.optional(),contentFetchedAt:string.optional() }).strict();
const feed = z.object({ id:string,name:string,url:string,website:string,category:string,color:string,initial:string,priority:z.boolean().optional() }).strict();
const preferences = z.object({ interests:strings,mutedTopics:strings,topicWeights:z.record(finite),sourceWeights:z.record(finite),diversity:score,categoryTabs:strings.max(50).optional() }).strict();
const reader = z.object({ version:z.literal(1),articles:z.array(articleSchema),feeds:z.array(feed),saved:strings,read:strings,backlogMigratedAt:string.optional(),folders:z.array(z.object({ name:z.string().min(1).max(200),feedIds:strings.max(1000) }).strict()).max(200).optional(),everSaved:z.array(z.object({ id:string,at:string }).strict()).max(MAX_EVER_SAVED).optional(),feedback:z.record(z.enum(['like','dislike'])),preferences,lastUpdated:string.nullable() }).strict();
const profile = z.object({ summary:string,boostTerms:strings,muteTerms:strings,preferredDepth:z.enum(['any','introductory','practical','advanced']) }).strict();
const analysis = z.object({ articleId:string,interest:score,importance:score,summary:string,reason:string,importanceReason:string,tags:z.array(z.string().max(40)).max(5).optional() }).strict();
const note = z.object({ id:string,articleId:string,quote:string,body:string,createdAt:string,updatedAt:string }).strict();
const digest = z.object({ title:string,overview:string,items:z.array(z.object({articleId:string,summary:string,takeaway:string,minutes:finite.min(0)}).strict()),totalMinutes:finite.min(0),generatedAt:string,mode:z.enum(['ai','extractive']) }).strict();
const report = z.object({ overview:string,developments:z.array(z.object({text:string,articleIds:strings}).strict()),perspectives:z.array(z.object({sourceName:string,point:string,articleIds:strings}).strict()),uncertainties:strings }).strict();
const answer = z.object({ answer:string,citations:z.array(z.object({articleId:string,quote:string}).strict()) }).strict();
const providerId = z.enum(PROVIDER_IDS);
const perProvider = <T extends z.ZodTypeAny>(value: T) => z.object(Object.fromEntries(PROVIDER_IDS.map((id) => [id, value.optional()])) as Record<typeof PROVIDER_IDS[number], z.ZodOptional<T>>).strict();
const aiSettings = z.object({ provider:providerId, models:perProvider(string.regex(MODEL_ID_PATTERN)), efforts:perProvider(z.enum(EFFORTS)) }).strict();
const intelligence = z.object({version:z.literal(1),instructions:string,profile:profile.nullable(),analysis:z.record(analysis),notes:z.array(note),exploration:score,digestMinutes:finite.positive(),digest:digest.nullable(),storyReports:z.record(report),chats:z.array(z.object({id:string,question:string,result:answer,createdAt:string}).strict()),ai:aiSettings.optional()}).strict();
const syncDocument = z.object({version:z.literal(2),reader,intelligence,updatedAt:string}).strict();

/** Shared by the browser cache and server. Never imports server runtime bindings. */
export function validateSyncDocument(value: unknown): value is SyncDocument {
  try {
    const pending:{value:unknown;depth:number}[]=[{value,depth:0}];
    const seen=new WeakSet<object>();
    while(pending.length) {
      const item=pending.pop()!;
      if (!item.value || typeof item.value!=='object') continue;
      if(item.depth>40) return false;
      if(seen.has(item.value))continue;
      seen.add(item.value);
      if(!Array.isArray(item.value)&&Object.getPrototypeOf(item.value)!==Object.prototype&&Object.getPrototypeOf(item.value)!==null) return false;
      for(const [key,child] of Object.entries(item.value)) {
        if(key==='__proto__'||key==='prototype'||key==='constructor') return false;
        pending.push({value:child,depth:item.depth+1});
      }
    }
    const serialized=JSON.stringify(value);
    return typeof serialized==='string' && syncDocument.safeParse(value).success;
  } catch { return false; }
}

export type LibraryDatabase = Pick<D1Database,'prepare'|'batch'>;
interface LibraryRow { document:string;revision:number;updated_at:string; }
interface JoinedRow extends LibraryRow { part:number|null;content:string|null; }
interface ChunkManifest { storage:'chunks-v1';operationToken:string;count:number; }
const CHUNK_BYTES=512*1024;
export const MAX_LIBRARY_REQUEST_BYTES=MAX_LIBRARY_BYTES+2048;
export class LibraryConflictError extends Error {
  readonly current:CloudLibrary;
  constructor(current:CloudLibrary) { super('別の端末で更新されています。保存する内容を選んでください。');this.name='LibraryConflictError';this.current=current; }
}
export class LibraryValidationError extends Error {
  constructor() { super('同期データの形式またはサイズが正しくありません。');this.name='LibraryValidationError'; }
}
function chunkDocument(serialized:string):string[] {
  const bytes=new TextEncoder().encode(serialized);
  if(bytes.byteLength>MAX_LIBRARY_BYTES)throw new LibraryValidationError();
  const decoder=new TextDecoder('utf-8',{fatal:true});const chunks:string[]=[];
  for(let start=0;start<bytes.length;) {
    let end=Math.min(start+CHUNK_BYTES,bytes.length);
    // Never split a UTF-8 code point. Each D1 string binding and row stays well
    // below D1's 2,000,000-byte limit, including row metadata.
    while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
    chunks.push(decoder.decode(bytes.subarray(start,end)));start=end;
  }
  return chunks;
}
function manifest(value:unknown):value is ChunkManifest {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const input=value as Record<string,unknown>;
  return input.storage==='chunks-v1'&&typeof input.operationToken==='string'&&input.operationToken.length>0&&typeof input.count==='number'&&Number.isInteger(input.count)&&input.count>0&&input.count<=10;
}
export async function getCloudLibrary(db:LibraryDatabase,userId:string):Promise<CloudLibrary> {
  if(!userId)throw new LibraryValidationError();
  // One joined SELECT observes a single SQLite snapshot, even when another batch
  // replaces the manifest and removes old chunks concurrently.
  const result=await db.prepare(`SELECT l.document, l.revision, l.updated_at, c.part, c.content
    FROM folio_libraries AS l LEFT JOIN folio_library_chunks AS c
      ON c.user_id = l.user_id AND c.operation_token = json_extract(l.document, '$.operationToken')
      AND json_extract(l.document, '$.storage') = 'chunks-v1'
    WHERE l.user_id = ? ORDER BY c.part`).bind(userId).all<JoinedRow>();
  const rows=result.results;
  if(!rows.length)return {document:null,revision:0,updatedAt:null,ownerId:userId};
  const row=rows[0];let document:unknown=JSON.parse(row.document);
  if(manifest(document)) {
    if(rows.length!==document.count||rows.some((part,index)=>part.part!==index||typeof part.content!=='string'))throw new Error('保存された同期データの断片を読み込めませんでした。');
    document=JSON.parse(rows.map(part=>part.content).join(''));
  }
  // Legacy rows contain the complete v2 document directly and remain readable.
  if(!validateSyncDocument(document)||!Number.isSafeInteger(row.revision)||row.revision<1)throw new Error('保存された同期データを読み込めませんでした。');
  return {document,revision:row.revision,updatedAt:row.updated_at,ownerId:userId};
}
export async function putCloudLibrary(db:LibraryDatabase,userId:string,document:SyncDocument,baseRevision:number,expectedOwnerId?:string):Promise<CloudLibrary> {
  // expectedOwnerId never selects the authorization scope. It only prevents an
  // account switch between GET and PUT from copying the old account's content.
  if(expectedOwnerId!==undefined&&expectedOwnerId!==userId)throw new LibraryConflictError(await getCloudLibrary(db,userId));
  if(!userId||!validateSyncDocument(document)||!Number.isSafeInteger(baseRevision)||baseRevision<0||baseRevision>=Number.MAX_SAFE_INTEGER)throw new LibraryValidationError();
  const chunks=chunkDocument(JSON.stringify(document));
  const operationToken=crypto.randomUUID();
  const metadata=JSON.stringify({storage:'chunks-v1',operationToken,count:chunks.length} satisfies ChunkManifest);
  const updatedAt=new Date().toISOString();
  const compareAndSwap=baseRevision===0
    ? db.prepare('INSERT INTO folio_libraries (user_id, document, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING RETURNING document, revision, updated_at').bind(userId,metadata,updatedAt)
    : db.prepare('UPDATE folio_libraries SET document = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ? RETURNING document, revision, updated_at').bind(metadata,updatedAt,userId,baseRevision);
  const insertChunks=chunks.map((content,part)=>db.prepare(`INSERT INTO folio_library_chunks (user_id, operation_token, part, content)
    SELECT ?, ?, ?, ? FROM folio_libraries WHERE user_id = ? AND document = ?`).bind(userId,operationToken,part,content,userId,metadata));
  const cleanup=db.prepare(`DELETE FROM folio_library_chunks WHERE user_id = ? AND operation_token <> ?
    AND EXISTS (SELECT 1 FROM folio_libraries WHERE user_id = ? AND document = ?)`).bind(userId,operationToken,userId,metadata);
  // D1 batch is transactional: a chunk failure rolls back metadata, all new
  // chunks and cleanup. A failed CAS cannot insert chunks or delete the winner.
  const results=await db.batch<LibraryRow>([compareAndSwap,...insertChunks,cleanup]);
  const saved=results[0]?.results[0];
  if(!saved)throw new LibraryConflictError(await getCloudLibrary(db,userId));
  return {document,revision:saved.revision,updatedAt:saved.updated_at,ownerId:userId};
}
