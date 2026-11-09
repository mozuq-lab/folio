import { MAX_LIBRARY_BYTES, validateSyncDocument } from './cloud-library.ts';
import { DEFAULT_INTELLIGENCE, type CloudLibrary, type IntelligenceState, type SyncDocument } from './intelligence-types.ts';
import { decodeState } from './storage.ts';
import type { ReaderState } from './types.ts';

export const WORKSPACE_KEY = 'folio.workspace.v2';
export const WORKSPACE_BACKUP_KEY = 'folio.workspace.v2.backup';
export const ownerBackupKey=(ownerId:string)=>`${WORKSPACE_BACKUP_KEY}.owner.${encodeURIComponent(ownerId)}`;
export type SyncStatus = 'loading'|'synced'|'syncing'|'offline'|'local'|'conflict'|'error';
export interface LibraryCache { document:SyncDocument;revision:number;pending:boolean;ownerId?:string; }
/**
 * 端末のバックログを開く持ち主。確かめた持ち主があればそれを使う。オフラインで確かめられないときだけ、
 * 端末のcacheの持ち主で端末内の記事を表示する（送信はバックログ側が持ち主を確かめるまで行わない）。
 */
export function backlogOwnerId(verified:string|null,status:SyncStatus,cached:string|undefined):string|null {
  return verified??(status==='offline'?cached??null:null);
}
// verifiedOwnerId はサーバーの応答で確かめた持ち主。端末のcacheにある ownerId は確かめる前の値なので使わない。
export interface LibraryView { cache:LibraryCache;ready:boolean;status:SyncStatus;error:string;userName:string;conflict:CloudLibrary|null;verifiedOwnerId:string|null; }
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const revision=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const owner=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
const emptyReader=():ReaderState=>({version:1,articles:[],feeds:[],saved:[],read:[],feedback:{},preferences:{interests:[],mutedTopics:[],topicWeights:{},sourceWeights:{},diversity:30},lastUpdated:null});
function freshCache(reader:ReaderState):LibraryCache {
  return {document:{version:2,reader:structuredClone(reader),intelligence:structuredClone(DEFAULT_INTELLIGENCE),updatedAt:new Date().toISOString()},revision:0,pending:false};
}
export function decodeCache(raw:string|null,fallbackReader:ReaderState,legacyRaw:string|null=null):{cache:LibraryCache;storageWarning:boolean} {
  if(raw) {
    try {
      const parsed:unknown=JSON.parse(raw);
      if(record(parsed)&&Object.keys(parsed).every(key=>['document','revision','pending','ownerId'].includes(key))&&validateSyncDocument(parsed.document)&&revision(parsed.revision)&&typeof parsed.pending==='boolean'&&(parsed.ownerId===undefined||owner(parsed.ownerId))) {
        return {cache:parsed as unknown as LibraryCache,storageWarning:false};
      }
    } catch { /* Caller preserves invalid bytes as a backup before recovery. */ }
  }
  const migrated=decodeState(legacyRaw,fallbackReader);
  const cache=freshCache(migrated);
  const valid=validateSyncDocument(cache.document);
  return {
    cache:valid?{...cache,pending:!!legacyRaw&&migrated!==fallbackReader}:freshCache(fallbackReader),
    storageWarning:!!raw||!!legacyRaw&&(migrated===fallbackReader||!valid),
  };
}
type OwnedCloudLibrary=CloudLibrary&{ownerId:string};
export function validateCloudLibrary(value:unknown):value is OwnedCloudLibrary {
  return record(value)&&owner(value.ownerId)&&revision(value.revision)&&(value.updatedAt===null||typeof value.updatedAt==='string')&&(value.userName===undefined||typeof value.userName==='string')&&(value.document===null?value.revision===0:validateSyncDocument(value.document)&&value.revision>0);
}
interface SyncOptions {
  fetcher?:typeof fetch;
  persist?:(cache:LibraryCache)=>void;
  backup?:(cache:LibraryCache)=>void;
  restore?:(ownerId:string)=>LibraryCache|null;
  fallbackReader?:ReaderState;
  onChange?:(view:LibraryView)=>void;
}
type StateUpdate<T>=T|((previous:T)=>T);
const errorMessage=(body:unknown,fallback:string)=>record(body)&&typeof body.error==='string'?body.error:fallback;

/** Owns the latest reader/intelligence pair independently of React renders. */
export class LibrarySyncController {
  view:LibraryView;
  private cache:LibraryCache;
  private options:SyncOptions;
  private fallbackReader:ReaderState;
  private cloudAvailable=false;
  private generation=0;
  private inFlight:Promise<void>|null=null;
  private hydrating:Promise<void>|null=null;
  private disposed=false;
  private verifiedOwner:string|null=null;
  constructor(cache:LibraryCache,options:SyncOptions={}) {
    this.options=options;this.cache=cache;
    this.fallbackReader=options.fallbackReader??emptyReader();
    // Cached private content stays hidden until GET establishes the owner, or
    // a failed network request explicitly allows offline viewing on this device.
    this.view={cache:freshCache(this.fallbackReader),ready:false,status:'loading',error:'',userName:'',conflict:null,verifiedOwnerId:null};
  }
  dispose():void { this.disposed=true; }
  private update(patch:Partial<LibraryView>):void {
    if(this.disposed)return;
    if(patch.cache) {this.cache=patch.cache;this.options.persist?.(patch.cache);}
    this.view={...this.view,...patch,verifiedOwnerId:this.verifiedOwner};this.options.onChange?.(this.view);
  }
  private request(init:RequestInit={}):Promise<Response> {
    return (this.options.fetcher??fetch)('/api/library',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),...init});
  }
  private activateOwner(ownerId:string):LibraryCache {
    if(this.cache.ownerId&&this.cache.ownerId!==ownerId) {
      this.archiveCache();
      const restored=this.restoreCache(ownerId);
      this.cache=restored?.ownerId===ownerId?restored:freshCache(this.fallbackReader);
      this.generation++;
    } else if(!this.cache.ownerId&&!this.cache.pending&&this.cache.revision===0) {
      const restored=this.restoreCache(ownerId);
      if(restored?.ownerId===ownerId)this.cache=restored;
    }
    this.verifiedOwner=ownerId;
    this.cache={...this.cache,ownerId};return this.cache;
  }
  private withoutVerifiedOwner():LibraryCache {
    this.verifiedOwner=null;
    if(this.cache.ownerId) {
      this.archiveCache();
      this.cache=freshCache(this.fallbackReader);this.generation++;
    }
    return this.cache;
  }
  private archiveCache():void {
    // Storage failure must never turn a verified account change into an offline
    // fallback that exposes the previous account. The hook reports the failure.
    try { this.options.backup?.(this.cache); } catch { /* Keep the new owner isolated. */ }
  }
  private restoreCache(ownerId:string):LibraryCache|null {
    try { return this.options.restore?.(ownerId)??null; } catch { return null; }
  }
  private unavailableCache(body:unknown):LibraryCache {
    return record(body)&&owner(body.ownerId)?this.activateOwner(body.ownerId):this.withoutVerifiedOwner();
  }
  private applyCloud(body:OwnedCloudLibrary):void {
    const cache=this.activateOwner(body.ownerId);
    const userName=body.userName??'';
    if(cache.pending&&body.document&&cache.revision!==body.revision) {
      this.update({ready:true,status:'conflict',error:'別の端末で更新されています。保存する内容を選んでください。',conflict:body,userName,cache});return;
    }
    if(cache.pending) {
      this.update({ready:true,status:'syncing',error:'',userName,conflict:null,cache:{...cache,revision:body.revision}});
    } else if(body.document) {
      this.update({ready:true,status:'synced',error:'',userName,conflict:null,cache:{document:body.document,revision:body.revision,pending:false,ownerId:body.ownerId}});
    } else {
      this.update({ready:true,status:'syncing',error:'',userName,conflict:null,cache:{...cache,revision:0,pending:true}});
    }
  }
  private edit(document:SyncDocument):void {
    this.generation++;
    const status=this.view.conflict?'conflict':this.cloudAvailable?'syncing':this.view.status;
    this.update({cache:{...this.cache,document:{...document,updatedAt:new Date().toISOString()},pending:true},status,error:this.view.conflict?this.view.error:''});
  }
  editReader(update:StateUpdate<ReaderState>):void {
    if(!this.view.ready)return;
    const document=this.cache.document;
    const reader=typeof update==='function'?update(document.reader):update;
    if(reader!==document.reader)this.edit({...document,reader});
  }
  editIntelligence(update:StateUpdate<IntelligenceState>):void {
    if(!this.view.ready)return;
    const document=this.cache.document;
    const intelligence=typeof update==='function'?update(document.intelligence):update;
    if(intelligence!==document.intelligence)this.edit({...document,intelligence});
  }
  hydrate():Promise<void> {
    if(this.hydrating)return this.hydrating;
    if(this.inFlight)return this.inFlight.then(()=>this.hydrate());
    if(this.disposed||this.view.conflict)return Promise.resolve();
    this.hydrating=this.loadCloud().finally(()=>{this.hydrating=null;});return this.hydrating;
  }
  private async loadCloud():Promise<void> {
    try {
      const response=await this.request();
      const body:unknown=await response.json().catch(()=>null);
      if(this.disposed)return;
      if(response.status===401) {
        this.cloudAvailable=false;
        this.update({ready:true,status:'local',error:errorMessage(body,'ログインしてください。'),cache:this.withoutVerifiedOwner(),conflict:null,userName:''});return;
      }
      if(response.status===503) {
        this.cloudAvailable=false;
        this.update({ready:true,status:'local',error:errorMessage(body,'この端末に保存しています。'),cache:this.unavailableCache(body),conflict:null,userName:record(body)&&typeof body.userName==='string'?body.userName:''});return;
      }
      if(!response.ok||!validateCloudLibrary(body)) {
        this.cloudAvailable=false;
        this.update({ready:true,status:'error',error:errorMessage(body,'クラウドのデータを読み込めませんでした。'),cache:this.unavailableCache(body),userName:'',conflict:null});return;
      }
      this.cloudAvailable=true;this.applyCloud(body);
    } catch {
      this.update({ready:true,status:'offline',error:'クラウドに接続できません。この端末に保存し、接続後に同期します。',cache:this.cache});
    }
  }
  flush():Promise<void> {
    if(this.inFlight)return this.inFlight;
    if(this.hydrating)return this.hydrating.then(()=>this.flush());
    if(this.disposed||!this.cloudAvailable||!this.view.ready||this.view.conflict||!this.cache.pending)return Promise.resolve();
    this.inFlight=this.sendPending().finally(()=>{this.inFlight=null;});return this.inFlight;
  }
  private async sendPending():Promise<void> {
    while(!this.disposed&&this.cache.pending&&!this.view.conflict) {
      const cache=this.cache;const generation=this.generation;let payload:string;
      try {
        const document=JSON.stringify(cache.document);
        if(new TextEncoder().encode(document).byteLength>MAX_LIBRARY_BYTES) {
          this.update({status:'error',error:'同期データが4MBを超えています。内容はこの端末に保持しています。'});return;
        }
        if(!cache.ownerId||!validateSyncDocument(JSON.parse(document))) {
          this.update({status:'error',error:'同期データの形式が正しくありません。内容はこの端末に保持しています。'});return;
        }
        payload=JSON.stringify({document:cache.document,baseRevision:cache.revision,expectedOwnerId:cache.ownerId});
      } catch {
        this.update({status:'error',error:'同期データを準備できませんでした。内容はこの端末に保持しています。'});return;
      }
      this.update({status:'syncing',error:''});
      try {
        const response=await this.request({method:'PUT',headers:{'Content-Type':'application/json'},body:payload,keepalive:new TextEncoder().encode(payload).byteLength<60000});
        const body:unknown=await response.json().catch(()=>null);
        if(this.disposed)return;
        if(response.status===409&&record(body)&&validateCloudLibrary(body.current)) {
          if(body.current.ownerId!==this.cache.ownerId) {this.applyCloud(body.current);return;}
          this.update({status:'conflict',error:errorMessage(body,'別の端末で更新されています。'),conflict:body.current});return;
        }
        if(response.status===401) {
          this.cloudAvailable=false;
          this.update({status:'local',error:errorMessage(body,'ログインしてください。'),cache:this.withoutVerifiedOwner(),conflict:null,userName:''});return;
        }
        if(response.status===503) {
          this.cloudAvailable=false;
          this.update({status:'local',error:errorMessage(body,'クラウド同期が利用できません。この端末に保存しています。'),cache:this.unavailableCache(body),conflict:null});return;
        }
        if(!response.ok||!validateCloudLibrary(body)||!body.document) {
          this.update({status:'error',error:errorMessage(body,'クラウドに保存できませんでした。内容はこの端末に保持しています。')});return;
        }
        if(body.ownerId!==this.cache.ownerId) {this.applyCloud(body);return;}
        const edited=this.generation!==generation;
        this.update({cache:{document:edited?this.cache.document:body.document,revision:body.revision,pending:edited,ownerId:body.ownerId},status:edited?'syncing':'synced',error:'',userName:body.userName??this.view.userName});
      } catch {
        this.update({status:'offline',error:'クラウドに接続できません。未送信の編集はこの端末に保持しています。'});return;
      }
    }
  }
  async syncNow():Promise<void> {
    if(this.disposed||this.view.conflict)return;
    if(!this.cloudAvailable||!this.view.ready||!this.cache.pending)await this.hydrate();
    await this.flush();
  }
  async resolveConflict(choice:'cloud'|'local'):Promise<void> {
    const current=this.view.conflict;
    if(!current||!validateCloudLibrary(current))return;
    if(current.ownerId!==this.cache.ownerId) {this.applyCloud(current);return;}
    this.generation++;
    if(choice==='cloud') {
      this.update({cache:{document:current.document??freshCache(this.fallbackReader).document,revision:current.revision,pending:!current.document,ownerId:current.ownerId},conflict:null,status:current.document?'synced':'syncing',error:'',userName:current.userName??this.view.userName});return;
    }
    this.update({cache:{...this.cache,revision:current.revision,pending:true},conflict:null,status:'syncing',error:''});await this.flush();
  }
}
