'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { AlertCircle, BookOpen, Circle, Cloud, CloudOff, Layers3, NotebookPen, Telescope, ArrowDownWideNarrow, ArrowRight, ArrowUpRight, Bookmark, BookmarkCheck, Check, CheckCheck, ChevronDown, ChevronRight, Download, ExternalLink, Folder, Heart, Inbox, LayoutGrid, Leaf, List, LoaderCircle, Menu, Plus, RefreshCw, Rows3, Rss, Search, Settings, Settings2, SlidersHorizontal, Sparkles, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { DEFAULT_PREFERENCES, INITIAL_FEEDS, SAMPLE_ARTICLES, TOPICS } from '@/lib/data';
import { applyFeedback } from '@/lib/recommendations';
import { clearStoryReports, retainedArticleIds } from '@/lib/retention';
import { useLibrary } from '@/hooks/use-library';
import { useBacklog } from '@/hooks/use-backlog';
import { freezeOrder, mergeReadIds, mergeViewArticles, routeReadChange } from '@/lib/backlog/view';
import { attachContent, needsBacklogMigration, retainArticle } from '@/lib/backlog/migration';
import { pruneLibrary, runBacklogMigration } from '@/lib/backlog/migration-runner';
import { backlogOwnerId } from '@/lib/client-library';
import { parseFeedStates, togglePriority, type FeedFetchState } from '@/lib/backlog/priority';
import { refreshFailureMessage, refreshTargets } from '@/lib/backlog/refresh';
import { parseViewParam, resolveView, viewHref } from '@/lib/sidebar';
import { UNFILED, addFeedsToFolders, folderFeedIds, moveUnfiledFeed, removeFeedFromFolders, resolveFolders, sidebarGroups, withCategories, type FeedFolder } from '@/lib/folders';
import { FeedOrganizer } from '@/components/folio/feed-organizer';
import { FeedIcon } from '@/components/folio/feed-icon';
import { useCollapsedFolders } from '@/hooks/use-collapsed-folders';
import { loadContent, saveContent } from '@/lib/backlog/client-db';
import { useArticleLayout } from '@/hooks/use-article-layout';
import type { ArticleLayout } from '@/lib/article-layout';
import { LoadMoreSentinel } from '@/components/folio/load-more-sentinel';
import { rankPersonalized, mixExploration, toArticle } from '@/lib/personalization';
import type { IntelligentArticle } from '@/lib/personalization';
import { selectExploration, applyNaturalProfile } from '@/lib/discovery';
import type { AIRequest, AIResult, SyncDocument } from '@/lib/intelligence-types';
import { analyzeBatches, mergeAnalysis, runAnalyzeBatches } from '@/lib/ai-analyze';
import { clientTimeoutMs, effectiveSelection } from '@/lib/ai-settings';
import { ANALYZE_BATCH_SIZE, MAX_REQUEST_ARTICLES, type ProviderStatus } from '@/lib/ai/types';
import { DigestView, NotebookView, ExploreView } from '@/components/folio/intelligence-panels';
import { FeedTransfer, NaturalPreferenceEditor, downloadFile } from '@/components/folio/library-dialogs';
import { ArticleReader } from '@/components/folio/article-reader';
import { LibraryBackupTransfer } from '@/components/folio/library-backup-transfer';
import { MarkAllRead } from '@/components/folio/mark-all-read';
import { Modal } from '@/components/folio/modal';
import './intelligence.css';
import type { Article, Feed, ReaderState } from '@/lib/types';

const INITIAL:ReaderState={version:1,articles:SAMPLE_ARTICLES,feeds:INITIAL_FEEDS,saved:[],read:[],feedback:{},preferences:DEFAULT_PREFERENCES,lastUpdated:null};
const loadAIStatuses=async():Promise<ProviderStatus[]>=>{try{const response=await fetch('/api/ai',{signal:AbortSignal.timeout(10000)});const result=await response.json() as {providers?:ProviderStatus[]};return response.ok&&Array.isArray(result.providers)?result.providers:[];}catch{return [];}};
const subscribeNever=()=>()=>{};
const readUrlView=()=>parseViewParam(new URLSearchParams(window.location.search).get('view'));
const CATEGORIES=['すべて','テクノロジー','デザイン','ビジネス','サイエンス','暮らし'];
const categoryMatches=(a:Article,c:string)=>c==='すべて'||a.tags.includes(c)||(c==='テクノロジー'&&a.tags.some(t=>['AI・機械学習','開発'].includes(t)))||(c==='ビジネス'&&a.tags.includes('スタートアップ'));
function relativeTime(date:string){const d=(Date.now()-new Date(date).getTime())/3600000;return !Number.isFinite(d)?'日付不明':d<1?'たった今':d<24?`${Math.floor(d)}時間前`:`${Math.floor(d/24)}日前`;}
function safeUrl(value:string|undefined){try{const u=new URL(value||'');return ['http:','https:'].includes(u.protocol)?u.href:undefined;}catch{return undefined;}}
function Logo(){return <span className="brand"><span className="brand-mark" aria-hidden="true"/><span>folio</span></span>;}

// 記事の見出しと画像。元記事のURLがあればリンクにして、中クリックやコンテキストメニューから元記事を新しいタブで開けるようにする。普通のクリックはFolioの中で開く。
function ArticleLink({className,href,title,label,onOpen,onRead,children}:{className:string;href:string|null|undefined;title?:string;label?:string;onOpen:()=>void;onRead:()=>void;children:React.ReactNode}){
 if(!href)return <button className={className} title={title} aria-label={label} onClick={onOpen}>{children}</button>;
 return <a className={className} href={href} target="_blank" rel="noopener noreferrer" title={title} aria-label={label} onClick={e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey){onRead();return;}e.preventDefault();onOpen();}} onAuxClick={e=>{if(e.button===1)onRead();}}>{children}</a>;
}
function ArticleCard({article,index,feed,saved,read,liked,onOpen,onSave,onFeedback,onToggleRead,onRead,layout,lens}:{article:IntelligentArticle;index:number;feed:Feed|undefined;saved:boolean;read:boolean;liked:boolean;onOpen:()=>void;onSave:()=>void;onFeedback:(value:'like'|'dislike')=>void;onToggleRead:()=>void;onRead:()=>void;layout:ArticleLayout;lens:'interest'|'importance'}){
 const [imageFailed,setImageFailed]=useState(false);
 const sourceUrl=safeUrl(article.url);
 const score=lens==='importance'?article.importance:article.interestScore;
 const readAction=read?'未読に戻す':'既読にする';
 return <article className={`article-card ${layout==='list'?'article-list-item':layout==='compact'?'article-compact':''} ${read?'is-read':''}`}>
  <ArticleLink className="article-image-button" href={sourceUrl} onOpen={onOpen} onRead={onRead} label={`${article.title}を読む`}>
   {safeUrl(article.image)&&!imageFailed?<img src={article.image} alt="" loading={index<2?'eager':'lazy'} onError={()=>setImageFailed(true)}/>:<div className="image-fallback"><Rss size={36}/><span>{article.sourceName}</span></div>}
   <span className="match-badge"><Sparkles size={12}/><strong>{score}</strong><span>{lens==='importance'?'重要度':'関心度'}</span></span>
   {read&&<span className="read-badge"><Check size={12}/>既読</span>}
  </ArticleLink>
  <div className="article-body"><div className="article-source"><FeedIcon feed={feed} fallback={article.sourceName}/><span>{article.sourceName}</span><span className="meta-dot">·</span><span>{relativeTime(article.publishedAt)}</span>{article.isSample&&<span className="card-sample">サンプル</span>}</div>
   <ArticleLink className="article-title-button" title={article.title} href={sourceUrl} onOpen={onOpen} onRead={onRead}><h3>{article.title}</h3></ArticleLink><p className="article-description">{article.aiSummary||article.description}</p>
   <div className="article-reason"><Sparkles size={12}/><span>{lens==='importance'?article.importanceReason:article.reason}</span>{article.aiAnalyzed&&<small className="ai-source-label">AI</small>}</div>
   <div className="article-footer">
    <div className="article-tags">{article.isExploration&&<span className="exploration-label">新しい視点</span>}{article.tags.slice(0,2).map(t=><span key={t}>{t}</span>)}</div>
    <div className="article-actions">
     <span className="compact-match" title={lens==='importance'?'重要度':'関心度'}><Sparkles size={12}/><strong>{score}</strong></span>
     <span className="reading-time">{article.readingMinutes}分</span>
     <button className={`icon-button like-button ${liked?'active':''}`} aria-label={`${article.title}に興味あり`} aria-pressed={liked} onClick={()=>onFeedback('like')}><ThumbsUp size={15}/></button>
     <button className={`icon-button read-toggle ${read?'active':''}`} aria-label={`${article.title}を${readAction}`} title={readAction} onClick={onToggleRead}>{read?<CheckCheck size={17}/>:<Circle size={17}/>}</button>
     <button className={`icon-button ${saved?'active':''}`} aria-label={saved?`${article.title}の保存を解除`:`${article.title}を保存`} title={saved?'保存を解除':'あとで読むに保存'} aria-pressed={saved} onClick={onSave}>{saved?<BookmarkCheck size={17}/>:<Bookmark size={17}/>}</button>
     {sourceUrl&&<a className="icon-button article-source-link" href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`${article.title}の元記事を新しいタブで開く`} title="元記事を新しいタブで開く" onClick={onRead} onAuxClick={event=>{if(event.button===1)onRead();}}><ExternalLink size={15}/><span>元記事</span></a>}
    </div>
   </div>
  </div>
 </article>;
}

export default function Home(){
 const {state,setState,intelligence,setIntelligence,ready,syncStatus,syncError,storageWarning,userName,ownerId,cachedOwnerId,snapshot,conflict,syncNow,resolveConflict}=useLibrary(INITIAL);
 // オフラインで持ち主を確かめられないときは、端末のcacheの持ち主で端末内の記事だけを表示する。移行・更新・まとめて既読は確かめた ownerId でだけ行う。
 const backlogOwner=backlogOwnerId(ownerId,syncStatus,cachedOwnerId??undefined);
 const {articles:backlogArticles,readIds:backlogReadIds,setRead:setBacklogRead,sendRead:sendBacklogRead,sync:syncBacklog,refreshFeeds,lastError:backlogError}=useBacklog(backlogOwner);
 // 表示はURLの ?view= から始める（別タブで開いたフィードなど）。購読していないフィードなら For You にする。
 const urlView=useSyncExternalStore(subscribeNever,readUrlView,()=>null);
 const [chosenView,setChosenView]=useState<string|null>(null);
 // 購読一覧が空のうち（オフラインや同期の失敗で読めていないときを含む）は、URLのフィードを捨てない。
 const view=resolveView(chosenView,urlView,state.feeds,ready&&state.feeds.length>0);
 // 並び順は、最初に選ばれるまで表示に合わせる。表示を変える前に今の並び順を確定し、検索や話題からの移動で並び順が変わらないようにする。
 const setView=(v:string)=>{if(sortChoice===null)setSort(sort);setChosenView(v);try{window.history.replaceState(window.history.state,'',viewHref(v));}catch{/* URLを変えられなくても表示は切り替える */}};
 const [chosenCategory,setCategory]=useState('すべて');
 const [query,setQuery]=useState('');
 const [sortChoice,setSort]=useState<string|null>(null);
 const sort=sortChoice??(view==='for-you'?'recommended':'latest');
 const [unreadOnly,setUnreadOnly]=useState(false);
 const [layout,setLayout]=useArticleLayout();
 const [modal,setModal]=useState<'feeds'|'preferences'|'backup'|null>(null);
 const [lens,setLens]=useState<'interest'|'importance'>('interest');
 const [visibleLimit,setVisibleLimit]=useState(30);
 const loadMore=useCallback(()=>setVisibleLimit(n=>n+30),[]);
 const [aiStatuses,setAIStatuses]=useState<ProviderStatus[]>([]);
 const [aiBusy,setAIBusy]=useState(false);
 const [aiError,setAIError]=useState('');
 const [aiProgress,setAIProgress]=useState<{done:number;total:number}|null>(null);
 const aiBusyRef=useRef(false);
 const [selected,setSelected]=useState<Article|null>(null);
 const [mobileMenu,setMobileMenu]=useState(false);
 const [refreshing,setRefreshing]=useState(false);
 const [refreshProgress,setRefreshProgress]=useState<{done:number;total:number}|null>(null);
 const [refreshNotice,setRefreshNotice]=useState('');
 // 取得中の数。フィードの追加と全体の更新が重なっても、全部終わるまでボタンを押せないようにする。
 const refreshRuns=useRef(0);
 const withRefreshing=useCallback(async<T,>(task:()=>Promise<T>):Promise<T>=>{refreshRuns.current++;setRefreshing(true);try{return await task();}finally{if(--refreshRuns.current===0){setRefreshing(false);setRefreshProgress(null);}}},[]);
 const [collapsedFolders,toggleCollapsedFolder,renameCollapsedFolder]=useCollapsedFolders();
 const [adding,setAdding]=useState(false);
 const [feedUrl,setFeedUrl]=useState('');
 const [feedError,setFeedError]=useState('');
 const [fetchStates,setFetchStates]=useState<Record<string,FeedFetchState>>({});
 useEffect(()=>{
  if(modal!=='feeds'||!ownerId)return;let active=true;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
  fetch('/api/feeds/state',{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(r=>r.ok?r.json():null).then((body:unknown)=>{if(active)setFetchStates(parseFeedStates(body));}).catch(()=>{}).finally(()=>clearTimeout(timer));
  return()=>{active=false;clearTimeout(timer);controller.abort();};
 },[modal,ownerId]);
 // 分類。保存が無ければ各フィードの分類名から作る。変えたら各フィードの分類名（OPMLの書き出しや以前の画面用）もそろえる。
 const folders=useMemo(()=>resolveFolders(state.feeds,state.folders),[state.feeds,state.folders]);
 // 名前を変えたり消したりした分類で絞り込んでいたら「すべて」に戻す。
 const category=CATEGORIES.includes(chosenCategory)||chosenCategory===UNFILED||folders.some(f=>f.name===chosenCategory)?chosenCategory:'すべて';
 const organize=useCallback((change:(folders:FeedFolder[])=>FeedFolder[])=>setState(s=>{const next=change(resolveFolders(s.feeds,s.folders));return {...s,folders:next,feeds:withCategories(s.feeds,next)};}),[setState]);
 const moveUnfiled=useCallback((from:number,to:number)=>setState(s=>({...s,feeds:moveUnfiledFeed(s.feeds,resolveFolders(s.feeds,s.folders),from,to)})),[setState]);
 const togglePriorityFeed=(id:string)=>setState(s=>{const r=togglePriority(s.feeds,id);setFeedError(r.error??'');return r.error?s:{...s,feeds:r.feeds};});
 const [message,setMessage]=useState('');
 const searchRef=useRef<HTMLInputElement>(null);
 // For You の並びは refreshToken が変わるまで固定する（更新・新着・開き直し・AIで選び直す）。settled は開いた直後の同期が終わったか。
 const [refreshToken,setRefreshToken]=useState(0);const [settled,setSettled]=useState(false);const [frozen,setFrozen]=useState<{ids:string[];token:number}|null>(null);const [migrationError,setMigrationError]=useState('');
 const stateRef=useRef(state);useEffect(()=>{stateRef.current=state;},[state]);const openedFor=useRef<string|null>(null);const migrating=useRef<Promise<void>|null>(null);
 useEffect(()=>{if(!message)return;const timer=setTimeout(()=>setMessage(''),4200);return()=>clearTimeout(timer);},[message]);
 useEffect(()=>{const handler=(e:KeyboardEvent)=>{if(e.key==='/'&&!(e.target instanceof HTMLInputElement)&&!(e.target instanceof HTMLTextAreaElement)){e.preventDefault();searchRef.current?.focus();}if(e.key==='Escape')setMobileMenu(false);};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[]);
 const notify=useCallback((s:string)=>setMessage(s),[]);
 // 表示用のreader：同期データ（保持対象の記事）とバックログの和。数万件になるので既読はSetで引く。
 const libraryIds=useMemo(()=>new Set(state.articles.map(a=>a.id)),[state.articles]);
 const viewArticles=useMemo(()=>mergeViewArticles(state.articles,backlogArticles,state.feeds),[state.articles,backlogArticles,state.feeds]);
 const readSet=useMemo(()=>mergeReadIds(state.read,backlogReadIds),[state.read,backlogReadIds]);
 const reader=useMemo<ReaderState>(()=>({...state,articles:viewArticles,read:[...readSet]}),[state,viewArticles,readSet]);
 const viewById=useMemo(()=>new Map(viewArticles.map(a=>[a.id,a])),[viewArticles]);
 const backlogIds=useMemo(()=>new Set(backlogArticles.map(a=>a.id)),[backlogArticles]);const backlogRef=useRef({ids:backlogIds,read:backlogReadIds});useEffect(()=>{backlogRef.current={ids:backlogIds,read:backlogReadIds};},[backlogIds,backlogReadIds]);
 const unreadCounts=useMemo(()=>{const byFeed=new Map<string,number>();let total=0;for(const a of viewArticles){if(readSet.has(a.id))continue;byFeed.set(a.sourceId,(byFeed.get(a.sourceId)||0)+1);if(state.feedback[a.id]!=='dislike')total++;}return {byFeed,total};},[viewArticles,readSet,state.feedback]);
 const unread=unreadCounts.total;
 const includeHidden=view==='saved';
 const intelligenceRef=useRef(intelligence);useEffect(()=>{intelligenceRef.current=intelligence;},[intelligence]);
 const baseRanked=useMemo(()=>rankPersonalized(viewArticles,state.preferences,state.feedback,intelligence,includeHidden),[viewArticles,state.preferences,state.feedback,intelligence.analysis,intelligence.profile,includeHidden]);
 const forYouRanked=useMemo(()=>{
  if(view!=='for-you')return baseRanked;
  const discoveries=selectExploration(applyNaturalProfile(viewArticles,intelligence.profile),state.preferences,state.feedback,10,baseRanked.slice(0,6).map(a=>a.id));
  return mixExploration(baseRanked,discoveries,intelligence.exploration);
 },[baseRanked,view,intelligence.exploration,intelligence.profile,viewArticles,state.preferences,state.feedback]);
 // For You は未読を候補に並べ、並びを固定する。既読にした記事は並び直すまで残し、届いた記事は件数だけ知らせる。
 const forYouCandidates=useMemo(()=>view==='for-you'?forYouRanked.filter(a=>!readSet.has(a.id)):[],[view,forYouRanked,readSet]);
 const frozenNext=useMemo(()=>freezeOrder(settled?frozen:null,forYouCandidates,refreshToken),[settled,frozen,forYouCandidates,refreshToken]);
 if(view==='for-you'&&settled&&(frozenNext.token!==frozen?.token||frozenNext.ids!==frozen?.ids))setFrozen({ids:frozenNext.ids,token:frozenNext.token});
 const ranked=useMemo(()=>{if(view!=='for-you')return baseRanked;const byId=new Map(forYouRanked.map(a=>[a.id,a]));return frozenNext.ids.map(id=>byId.get(id)).filter((a):a is IntelligentArticle=>!!a);},[view,baseRanked,forYouRanked,frozenNext.ids]);
 const newCount=view==='for-you'?frozenNext.newCount:0;
 const rerank=()=>{window.scrollTo({top:0,behavior:'auto'});setVisibleLimit(30);setRefreshToken(t=>t+1);};
 const aiSelection=useMemo(()=>effectiveSelection(intelligence.ai,aiStatuses),[intelligence.ai,aiStatuses]);const aiAvailable=!!aiSelection?.available;
 const checkAI=useCallback(()=>loadAIStatuses().then(setAIStatuses),[]);
 useEffect(()=>{if(!ready)return;let active=true;void loadAIStatuses().then(statuses=>{if(active)setAIStatuses(statuses);});return()=>{active=false;};},[ready]);
 // AIへ1回送る。実行中かどうかの管理は呼び出し側で行う。
 const sendAI=useCallback(async(request:AIRequest):Promise<AIResult>=>{
  if(!aiSelection)throw new Error('AIは未接続です。設定画面で提供元を選び、APIキーを登録してください。');const payload={...request,provider:aiSelection.provider,model:aiSelection.model,effort:aiSelection.effort,articles:request.articles.slice(0,request.action==='analyze'?ANALYZE_BATCH_SIZE:MAX_REQUEST_ARTICLES).map(a=>({...toArticle(a),content:a.content?.slice(0,18000)}))};const response=await fetch('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(clientTimeoutMs(aiSelection.effort))});const result=await response.json() as AIResult&{error?:string};if(!response.ok){if(response.status===503)void checkAI();throw new Error(result.error||'AI処理を完了できませんでした。');}return result;
 },[aiSelection,checkAI]);
 const requestAI=useCallback(async(request:AIRequest):Promise<AIResult>=>{
  if(aiBusyRef.current)throw new Error('別のAI処理が実行中です。完了をお待ちください。');
  aiBusyRef.current=true;setAIBusy(true);setAIError('');
  try{return await sendAI(request);
  }catch(error){const message=error instanceof Error?error.message:'AI処理を完了できませんでした。';setAIError(message);throw new Error(message);}finally{aiBusyRef.current=false;setAIBusy(false);}
 },[sendAI]);
 // AIで選び直す：未読の上位300件を見出しだけにして50件ずつ、2つ並行で送る。評価できた分だけを保存する。
 const analyze=async()=>{
  if(aiBusyRef.current)return;
  const batches=analyzeBatches(ranked.filter(a=>!readSet.has(a.id)));if(!batches.length)return;
  const total=batches.reduce((n,b)=>n+b.length,0);const instruction=`興味のあるトピック: ${state.preferences.interests.join('、')}。${intelligence.instructions}`;
  aiBusyRef.current=true;setAIBusy(true);setAIError('');setAIProgress({done:0,total});
  try{const {results,failed,firstError}=await runAnalyzeBatches(batches,async batch=>{const result=await sendAI({action:'analyze',articles:batch,instruction});return result.kind==='analyze'?result.analysis:[];},{onProgress:done=>setAIProgress({done,total})});
   if(results.length){const keep=new Set(viewArticles.map(a=>a.id));setIntelligence(s=>({...s,analysis:mergeAnalysis(s.analysis,results,keep)}));notify(failed?`${results.length}記事をAIで評価しました（${failed}件は評価できませんでした）`:`${results.length}記事をAIで評価しました`);rerank();}
   else if(firstError)setAIError(firstError);
  }finally{aiBusyRef.current=false;setAIBusy(false);setAIProgress(null);}
 };

 const filtered=useMemo(()=>{
  const categoryFeeds=new Set(folderFeedIds(state.feeds,folders,category));
  let result=ranked.filter(a=>(categoryMatches(a,category)||categoryFeeds.has(a.sourceId))&&(!unreadOnly||!readSet.has(a.id)));
  if(view==='saved'){const saved=new Set(state.saved);result=result.filter(a=>saved.has(a.id));}
  if(view.startsWith('feed:'))result=result.filter(a=>a.sourceId===view.slice(5));
  if(query.trim()){const q=query.toLocaleLowerCase();result=result.filter(a=>[a.title,a.description,a.sourceName,...a.tags].join(' ').toLocaleLowerCase().includes(q));}
  if(lens==='importance'&&sort!=='latest')result=[...result].sort((a,b)=>b.importance-a.importance);
  if(sort==='latest')result=[...result].sort((a,b)=>(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0));
  return result;
 },[ranked,view,category,unreadOnly,readSet,state.saved,state.feeds,folders,query,sort,lens]);
 const unreadShown=useMemo(()=>filtered.filter(a=>!readSet.has(a.id)).map(a=>a.id),[filtered,readSet]);
 const digestArticles=useMemo(()=>view==='digest'?baseRanked.map(toArticle):[],[view,baseRanked]);
 const isSample=viewArticles.length>0&&viewArticles.every(a=>a.isSample);
 const activeFeed=view.startsWith('feed:')?state.feeds.find(f=>f.id===view.slice(5)):null;
 const featureTitles:Record<string,[string,string]>={digest:['今日のダイジェスト','限られた時間で、大切なストーリーに出会う。'],notebook:['ナレッジノート','読んだことを、あなたの知識に。'],explore:['新しい発見','いつもの好奇心の、少し先へ。']};
 const isFeature=!!featureTitles[view];
 const title=featureTitles[view]?.[0]||(view==='saved'?'あとで読む':view==='all'?'すべての記事':activeFeed?activeFeed.name:'今日のあなたへ');
 const subtitle=featureTitles[view]?.[1]||(view==='saved'?'気になった記事を、あなたのペースで。':view==='all'?'フォローしているメディアの、新しいストーリー。':activeFeed?'このフィードの最新記事をチェック。':'たくさんの情報から、あなたにとって大切なものを。');
 const changeView=(v:string)=>{window.scrollTo({top:0,behavior:'auto'});setView(v);setVisibleLimit(30);setCategory('すべて');setQuery('');setSort(v==='for-you'?'recommended':'latest');setMobileMenu(false);setRefreshNotice('');};
 // 購読していないフィードのURLで開いて For You に戻したときは、URLも戻す。
 useEffect(()=>{if(urlView&&!chosenView&&view!==urlView)try{window.history.replaceState(window.history.state,'',viewHref(view));}catch{/* 表示はすでに戻っている */}},[urlView,chosenView,view]);
 // 保持対象にした記事は、端末だけにある本文も同期データへ写す。
 const retainContent=(a:Article)=>{if(a.content||!backlogOwner)return;void loadContent(backlogOwner,a.id).then(stored=>{if(stored)setState(s=>attachContent(s,a.id,stored));});};
 const save=(a:Article)=>{const saved=state.saved.includes(a.id);setState(s=>saved?{...s,saved:s.saved.filter(id=>id!==a.id)}:retainArticle({...s,saved:[...s.saved,a.id]},toArticle(a)));if(!saved)retainContent(a);notify(saved?'あとで読むから削除しました':'あとで読むに保存しました');};
 const feedback=(a:Article,value:'like'|'dislike')=>{setState(s=>{const previous=s.feedback[a.id];const next=previous===value?undefined:value;const f={...s.feedback};if(next)f[a.id]=next;else delete f[a.id];return {...s,feedback:f,preferences:applyFeedback(s.preferences,a,previous,next)};});notify(value==='like'?'フィードバックを好みに反映しました':'この記事を非表示にして、おすすめを調整しました');if(value==='dislike')setSelected(null);};
 // 既読の置き場所：同期データに本体がある記事は同期データの read、それ以外はバックログ（サーバーの read_at）。
 const changeLibraryRead=(ids:string[],read:boolean)=>{const set=new Set(ids);setState(s=>{if(!read)return {...s,read:s.read.filter(id=>!set.has(id))};const known=new Set(s.read);return {...s,read:[...s.read,...ids.filter(id=>!known.has(id))]};});};
 const changeRead=(ids:string[],read:boolean)=>{const route=routeReadChange(ids,read,libraryIds,backlogReadIds);if(route.library.length)changeLibraryRead(route.library,read);if(route.backlog.length)setBacklogRead(route.backlog,read);};
 const markRead=(a:Article)=>{if(!readSet.has(a.id))changeRead([a.id],true);};
 const markUnread=(a:Article)=>{changeRead([a.id],false);notify('未読に戻しました');};
 const toggleRead=(a:Article)=>{if(readSet.has(a.id))markUnread(a);else{markRead(a);notify('既読にしました');}};
 const markReadBatch=async(ids:string[])=>{const route=routeReadChange(ids,true,libraryIds,backlogReadIds);if(route.library.length)changeLibraryRead(route.library,true);return route.backlog.length?sendBacklogRead(route.backlog,true):true;};
 // 同期データに無い記事の本文は、この端末にだけ保存してある。
 const openArticle=(a:Article)=>{const article=toArticle(a);setSelected(article);markRead(a);if(!article.content&&backlogOwner){const owner=backlogOwner;void loadContent(owner,article.id).then(stored=>{if(stored)setSelected(current=>current?.id===article.id&&!current.content?{...current,content:stored.content,contentFetchedAt:stored.fetchedAt}:current);});}};
 const toggleInterest=(topic:string)=>setState(s=>({...s,preferences:{...s.preferences,interests:s.preferences.interests.includes(topic)?s.preferences.interests.filter(t=>t!==topic):[...s.preferences.interests,topic],mutedTopics:s.preferences.mutedTopics.filter(t=>t!==topic)}}));
 // 更新：フィードを表示中ならそのフィードだけ、それ以外は全フィードをサーバーで数件ずつ取得してから差分を受け取り、For You を並び直す。
 const refresh=async()=>{
  if(refreshRuns.current>0||!ownerId)return;
  const targets=refreshTargets(state.feeds,view);const all=!activeFeed;
  setRefreshNotice('');
  // 「最終更新」は全フィードを頼み終えたときだけ進める。取得できなかったフィードは知らせで示す。
  await withRefreshing(async()=>{const outcome=await refreshFeeds(targets,(done,total)=>setRefreshProgress({done,total}));if(outcome.completed&&all)setState(s=>({...s,lastUpdated:new Date().toISOString()}));setRefreshNotice(outcome.stopped?'':refreshFailureMessage(state.feeds,targets.length,outcome.failed));pruneLibraryArticles();rerank();});
 };
 // 追加したフィードをサーバーの購読一覧に送ってから、そのフィードだけを取得する。
 const fetchAddedFeed=(id:string)=>withRefreshing(async()=>{await syncNow();const outcome=await refreshFeeds([id]);if(!outcome.stopped&&outcome.failed.length)setRefreshNotice(refreshFailureMessage(stateRef.current.feeds,1,outcome.failed));});
 const addFeed=async(e:React.FormEvent)=>{
  e.preventDefault();if(adding)return;setFeedError('');
  let normalized:string;try{normalized=new URL(feedUrl.trim()).href;}catch{setFeedError('https:// から始まるRSSのURLを入力してください。');return;}
  if(state.feeds.some(f=>f.url===normalized)){setFeedError('このフィードはすでに購読しています。');return;}
  setAdding(true);try{const r=await fetch(`/api/feeds?url=${encodeURIComponent(normalized)}`);const data=await r.json() as {error?:string;feed:Feed};if(!r.ok)throw new Error(data.error||'フィードを追加できませんでした。');const f=data.feed as Feed;setState(s=>({...s,feeds:[...s.feeds,f],...(s.folders?{folders:addFeedsToFolders(s.folders,[f],{createMissing:false})}:{})}));setFeedUrl('');notify(`${f.name}を購読しました`);setModal(null);changeView(`feed:${f.id}`);void fetchAddedFeed(f.id);}catch(err){setFeedError(err instanceof Error?err.message:'フィードを取得できませんでした。');}finally{setAdding(false);}
 };
 const removeFeed=(f:Feed)=>{setState(s=>{const keep=new Set(retainedArticleIds(s,intelligence));return {...s,feeds:s.feeds.filter(x=>x.id!==f.id),...(s.folders?{folders:removeFeedFromFolders(s.folders,f.id)}:{}),articles:s.articles.filter(a=>a.sourceId!==f.id||keep.has(a.id))};});if(view===`feed:${f.id}`)changeView('for-you');notify(`${f.name}の購読を解除しました`);};
 const exportData=()=>{const document:SyncDocument={version:2,reader:state,intelligence,updatedAt:new Date().toISOString()};downloadFile(JSON.stringify(document,null,2),'folio-library.json');notify('メモと好みを含むライブラリを書き出しました');};
 const onImport=(feeds:Feed[])=>{setState(s=>{const known=new Set(s.feeds.map(f=>f.url.replace(/\/$/,'')));const added=feeds.filter(f=>!known.has(f.url.replace(/\/$/,'')));return {...s,feeds:[...s.feeds,...added],...(s.folders?{folders:addFeedsToFolders(s.folders,added)}:{})};});notify(`${feeds.length}件のフィードを追加しました。記事は自動で順に取得します。`);};
 const featureProps={reader,intelligence,setIntelligence,onOpen:openArticle,onSave:save,onFeedback:feedback,requestAI,aiAvailable,aiBusy,aiLabel:aiSelection?`${aiSelection.label}・${aiSelection.model}`:''};
 const syncLabels={loading:'ライブラリを読込中',synced:'すべての端末に同期済み',syncing:'変更を同期中…',offline:'オフライン・この端末に保存',local:'この端末に保存',conflict:'別の端末で変更があります',error:'同期を確認してください'};
 // 保持対象でなくなった記事（保存の解除・作り直したダイジェスト・消した質問など）を同期データから外す。既読はバックログにある記事の分だけ引き継ぐ。
 const pruneLibraryArticles=useCallback(()=>{
  const current=snapshot();if(!ownerId||current?.ownerId!==ownerId)return;
  let handOver:string[]=[];
  setState(s=>{const result=pruneLibrary(s,snapshot()?.intelligence??intelligenceRef.current);handOver=result.readHandOver;return result.reader;});
  const {ids,read}=backlogRef.current;const known=handOver.filter(id=>ids.has(id)&&!read.has(id));if(known.length)setBacklogRead(known,true);
 },[ownerId,snapshot,setState,setBacklogRead]);
 // 移行：同期データの記事と既読をすべてバックログへ送り、全部届いてから取り込んだ記事を同期データから外す。持ち主が替わったら止め、失敗したら次に開いたときにやり直す。
 const migrationNeeded=needsBacklogMigration(state);
 const migrateBacklog=useCallback(()=>{
  if(migrating.current)return migrating.current;
  if(!ownerId)return Promise.resolve();
  const owner=ownerId;
  const run=(async()=>{
   const post=async(body:unknown)=>{const response=await fetch('/api/articles/import',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});return response.ok?await response.json().catch(()=>null) as unknown:null;};
   const outcome=await runBacklogMigration({ownerId:owner,library:snapshot,post,syncBacklog,updateReader:setState,setBacklogRead});
   if(outcome==='failed'){setMigrationError('これまでの記事を移せませんでした。次に開いたときにもう一度試します。');return;}
   setMigrationError('');if(outcome==='done')pruneLibraryArticles();
  })();
  migrating.current=run;void run.finally(()=>{if(migrating.current===run)migrating.current=null;});
  return run;
 },[ownerId,snapshot,syncBacklog,setBacklogRead,setState,pruneLibraryArticles]);
 // 開いたとき：移行→差分の取得→（初回だけ）全フィードの取得。終わったら For You を並べる。
 useEffect(()=>{
  if(!ownerId)return;let active=true;
  void (async()=>{
   if(migrationNeeded)await migrateBacklog();
   if(openedFor.current!==ownerId){
    openedFor.current=ownerId;await syncBacklog();
    const current=stateRef.current;
    if(!current.lastUpdated&&current.feeds.length)await withRefreshing(async()=>{await syncNow();const targets=refreshTargets(current.feeds,'all');const outcome=await refreshFeeds(targets,(done,total)=>setRefreshProgress({done,total}));if(outcome.stopped)return;setState(s=>({...s,lastUpdated:new Date().toISOString()}));setRefreshNotice(refreshFailureMessage(current.feeds,targets.length,outcome.failed));});
   }
   if(active){setSettled(true);setRefreshToken(t=>t+1);}
  })();
  return()=>{active=false;};
 },[ownerId,migrationNeeded,migrateBacklog,syncBacklog,syncNow,refreshFeeds,setState,withRefreshing]);
 // 保存・メモ・AIの結果が参照した記事の本体を同期データへ写す（90日を過ぎても参照先が消えないように）。
 useEffect(()=>{const missing=retainedArticleIds(state,intelligence).filter(id=>!libraryIds.has(id)).map(id=>viewById.get(id)).filter((a):a is Article=>!!a);if(missing.length)setState(s=>missing.reduce((r,a)=>retainArticle(r,toArticle(a)),s));},[state,intelligence,libraryIds,viewById,setState]);
 // 「ニュースのまとまり」をなくしたので、保存済みの比較結果を同期データから消す（参照していた記事は次の整理で外れる）。
 useEffect(()=>{if(ready&&Object.keys(intelligence.storyReports).length)setIntelligence(clearStoryReports);},[ready,intelligence.storyReports,setIntelligence]);
 const feedbackCount=Object.keys(state.feedback).length;
 return <div className="app-shell">
  {mobileMenu&&<div className="sidebar-scrim" onClick={()=>setMobileMenu(false)}/>}
  <aside className={`sidebar ${mobileMenu?'sidebar-open':''}`}>
   <Link className="brand-link" href="/" aria-label="Folio ホーム"><Logo/></Link>
   <div className="sidebar-label">あなたのライブラリ</div>
   <nav className="main-nav" aria-label="メインメニュー">
    <button className={view==='for-you'?'nav-item selected':'nav-item'} onClick={()=>changeView('for-you')}><Sparkles size={18}/><span>For You</span><span className="nav-new">{aiAvailable?'AI':'YOU'}</span></button>
    <button className={view==='digest'?'nav-item selected':'nav-item'} onClick={()=>changeView('digest')}><BookOpen size={18}/><span>今日のダイジェスト</span></button>
    <button className={view==='notebook'?'nav-item selected':'nav-item'} onClick={()=>changeView('notebook')}><NotebookPen size={18}/><span>ナレッジノート</span>{intelligence.notes.length>0&&<span className="nav-count">{intelligence.notes.length}</span>}</button>
    <button className={view==='explore'?'nav-item selected':'nav-item'} onClick={()=>changeView('explore')}><Telescope size={18}/><span>新しい発見</span></button>
    <button className={view==='all'?'nav-item selected':'nav-item'} onClick={()=>changeView('all')}><Inbox size={18}/><span>すべての記事</span><span className="nav-count">{unread}</span></button>
    <button className={view==='saved'?'nav-item selected':'nav-item'} onClick={()=>changeView('saved')}><Bookmark size={18}/><span>あとで読む</span><span className="nav-count">{state.saved.length||''}</span></button>
   </nav>
   <div className="sidebar-divider"/><div className="sidebar-label feeds-label"><span>フォロー中のフィード</span><span className="feeds-label-actions"><button className="icon-button" aria-label="フィードの管理" title="フィードの管理" onClick={()=>setModal('feeds')}><Settings size={15}/></button><button className="icon-button" aria-label="フィードを追加" title="フィードを追加" onClick={()=>setModal('feeds')}><Plus size={16}/></button></span></div>
   <div className="feed-nav">{sidebarGroups(state.feeds,folders).map(({name:c,feeds:members})=><div className="feed-group" key={c}><div className="folder-row"><button className="folder-toggle" aria-expanded={!collapsedFolders.has(c)} aria-label={`${c}を${collapsedFolders.has(c)?'開く':'閉じる'}`} onClick={()=>toggleCollapsedFolder(c)}><ChevronDown size={13} className={collapsedFolders.has(c)?'is-collapsed':undefined}/></button><button className="folder-button" onClick={()=>{changeView('all');setCategory(c);}}><Folder size={15}/><span className="feed-name">{c}</span>{collapsedFolders.has(c)&&<span className="feed-unread">{members.reduce((n,f)=>n+(unreadCounts.byFeed.get(f.id)||0),0)||''}</span>}</button></div>{!collapsedFolders.has(c)&&members.map(f=><button key={f.id} className={`feed-link ${view===`feed:${f.id}`?'active':''}`} aria-current={view===`feed:${f.id}`?'page':undefined} onClick={()=>changeView(`feed:${f.id}`)}><FeedIcon feed={f}/><span className="feed-name">{f.name}</span><span className="feed-unread">{unreadCounts.byFeed.get(f.id)||''}</span></button>)}</div>)}</div>
   <div className="sidebar-bottom"><button className="nav-item" onClick={()=>setModal('backup')}><Download size={18}/><span>データの移行・バックアップ</span></button><button className="nav-item" onClick={()=>setModal('preferences')}><Settings2 size={18}/><span>好みをカスタマイズ</span></button><div className="profile"><span className="profile-avatar">{userName?.[0]||'Y'}<span/></span><div><strong>{userName||'あなたのライブラリ'}</strong><button className={`sync-state sync-${syncStatus}`} onClick={()=>void syncNow()} title={syncError||'クリックして同期'}>{syncStatus==='offline'?<CloudOff size={10}/>:syncStatus==='conflict'?<AlertCircle size={10}/>:<Cloud size={10}/>}<span>{storageWarning?'保存容量を確認してください':syncLabels[syncStatus]}</span></button></div><button className="icon-button" aria-label="ライブラリをエクスポート" onClick={exportData}><Download size={16}/></button></div></div>
  </aside>
  <div className="workspace">
   <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu-button" aria-label="メニューを開く" onClick={()=>setMobileMenu(true)}><Menu size={21}/></button><span>マイライブラリ</span><ChevronRight size={13}/><strong>{view==='for-you'?'For You':title}</strong></div><label className="search-box"><Search size={16}/><input ref={searchRef} value={query} onChange={e=>{if(isFeature){setView('all');setCategory('すべて');}setQuery(e.target.value);setVisibleLimit(30);}} placeholder="記事やキーワードを検索" aria-label="記事を検索"/>{query?<button className="icon-button" aria-label="検索をクリア" onClick={()=>setQuery('')}><X size={13}/></button>:<kbd>/</kbd>}</label><button className="topbar-settings icon-button" aria-label="好みの設定" onClick={()=>setModal('preferences')}><SlidersHorizontal size={18}/></button><button className="small-profile" aria-label="同期を実行" onClick={()=>void syncNow()} title={syncLabels[syncStatus]}>{userName?.[0]||'Y'}</button></header>
   <main className="main-layout"><div className="main-column">
    <div className="page-heading"><div><div className="date-label">{new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'long',day:'numeric',weekday:'long'}).format(new Date())}<span className="date-line"/></div><h1>{title}<span className="heading-dot">.</span></h1><p>{subtitle}</p></div><button className={`refresh-button ${refreshing?'is-refreshing':''}`} onClick={refresh} disabled={refreshing||!ownerId}><RefreshCw size={15} className={refreshing?'spin':''}/><span>{refreshing?(refreshProgress&&refreshProgress.total>1?`更新中… ${refreshProgress.done}/${refreshProgress.total}`:'更新中…'):activeFeed?'このフィードを更新':'フィードを更新'}</span></button></div>
    {!ready&&<div className="library-status-banner"><LoaderCircle size={14} className="spin"/>ライブラリを読み込んでいます…</div>}{ready&&(syncStatus==='error'||storageWarning)&&<div className="library-status-banner warning"><AlertCircle size={14}/><span>{storageWarning?'端末への保存に失敗しました。バックアップを書き出してください。':syncError}</span><button onClick={exportData}>バックアップ</button><button onClick={()=>void syncNow()}>再同期</button></div>}{ready&&(migrationError||backlogError)&&<div className="library-status-banner warning"><AlertCircle size={14}/><span>{migrationError||backlogError}</span><button onClick={()=>void (migrationError?migrateBacklog():syncBacklog())}>再試行</button></div>}{refreshNotice&&<div className="library-status-banner warning" role="status"><AlertCircle size={14}/><span>{refreshNotice}</span><button onClick={()=>setModal('feeds')}>フィードの管理</button><button onClick={()=>setRefreshNotice('')}>閉じる</button></div>}
    {isFeature?<>{view==='digest'&&<DigestView {...featureProps} reader={{...reader,articles:digestArticles}}/ >}{view==='notebook'&&<NotebookView {...featureProps}/ >}{view==='explore'&&<ExploreView {...featureProps}/ >}</>:<>
    {view==='for-you'&&!query&&<section className="welcome-banner"><div className="banner-copy"><div className="eyebrow"><span className="status-dot"/>A LITTLE MORE YOU</div><h2>好奇心が、次の発見を連れてくる。</h2><p>あなたの「好き」から、読むべきストーリーを。</p></div><button className="banner-action" onClick={()=>setModal('preferences')}>興味のあることを教える<ArrowRight size={15}/></button></section>}
    {view==='for-you'&&<div className="intelligence-toolbar"><div className="ranking-lenses" role="group" aria-label="おすすめの評価軸"><button className={lens==='interest'?'active':''} onClick={()=>setLens('interest')}><Heart size={14}/>関心度</button><button className={lens==='importance'?'active':''} onClick={()=>setLens('importance')}><Layers3 size={14}/>重要度</button></div><button className="ai-evaluate-button" disabled={!aiAvailable||aiBusy||!baseRanked.length} onClick={()=>void analyze()}>{aiBusy?<LoaderCircle size={14} className="spin"/>:<Sparkles size={14}/ >}{aiBusy?(aiProgress?`AIが評価中… ${aiProgress.done}/${aiProgress.total}`:'AIが評価中…'):'AIで選び直す'}</button></div>}{view==='for-you'&&<div className="ranking-explainer"><span>{lens==='interest'?'あなたの興味と自然文の好みを反映。探索枠は新しい視点を届けます。':'影響・緊急性を評価。AI未評価の記事は掲載状況と言葉からの推定です。'}</span><button onClick={()=>void checkAI()}>{aiAvailable?'AI利用設定済み':'AI接続の準備中'}</button></div>}{aiError&&view==='for-you'&&<p className="inline-ai-error" role="alert">{aiError}</p>}
    <div className="category-tabs" aria-label="記事のカテゴリ">{CATEGORIES.map(c=><button key={c} className={category===c?'active':''} onClick={()=>setCategory(c)}>{c}</button>)}</div>
    <div className="section-heading"><div className="section-title">{view==='for-you'?<Sparkles size={19}/>:view==='saved'?<Bookmark size={19}/>:<Rss size={19}/>}<h2>{query?`「${query}」の検索結果`:view==='for-you'?'あなたへのおすすめ':view==='saved'?'保存した記事':'記事一覧'}</h2><span className="article-count">{filtered.length}</span>{isSample&&<span className="sample-label">サンプル</span>}</div><div className="view-controls"><label className="sort-control"><ArrowDownWideNarrow size={14}/><select aria-label="記事の並び順" value={sort} onChange={e=>setSort(e.target.value)}><option value="recommended">おすすめ順</option><option value="latest">新しい順</option></select><ChevronDown size={11}/></label><div className="layout-toggle" role="group" aria-label="記事の表示形式"><button className={layout==='grid'?'active':''} aria-label="カード表示" title="カード表示" aria-pressed={layout==='grid'} onClick={()=>setLayout('grid')}><LayoutGrid size={15}/></button><button className={layout==='list'?'active':''} aria-label="リスト表示" title="リスト表示" aria-pressed={layout==='list'} onClick={()=>setLayout('list')}><List size={16}/></button><button className={layout==='compact'?'active':''} aria-label="コンパクト表示" title="コンパクト表示：見出しを1行で表示" aria-pressed={layout==='compact'} onClick={()=>setLayout('compact')}><Rows3 size={16}/></button></div></div></div>
    <div className="results-meta"><span>{isSample?'まずはサンプル記事で体験。更新すると実際のRSSを取得できます。':state.lastUpdated?`最終更新 ${relativeTime(state.lastUpdated)} · あなたの関心に合わせてセレクト`:'あなたの関心に合わせてセレクト'}</span><div className="results-actions"><MarkAllRead disabled={!ownerId} unreadIds={unreadShown} send={markReadBatch} onDone={count=>notify(`${count}件を既読にしました`)}/><label className="unread-toggle"><input type="checkbox" checked={unreadOnly} onChange={e=>setUnreadOnly(e.target.checked)}/><span>未読のみ</span></label></div></div>
    {newCount>0&&<button className="new-articles-button" onClick={rerank}><RefreshCw size={14}/>新着{newCount}件</button>}
    {filtered.length?<div className={`articles-grid ${layout==='list'?'list-layout':layout==='compact'?'compact-layout':''}`}>{filtered.slice(0,visibleLimit).map((a,i)=><ArticleCard key={a.id} article={a} index={i} feed={state.feeds.find(f=>f.id===a.sourceId)} saved={state.saved.includes(a.id)} read={readSet.has(a.id)} liked={state.feedback[a.id]==='like'} onOpen={()=>openArticle(a)} onSave={()=>save(a)} onFeedback={value=>feedback(a,value)} onToggleRead={()=>toggleRead(a)} onRead={()=>markRead(a)} layout={layout} lens={lens}/>)}</div>:<div className="empty-state"><span>{view==='saved'?<Bookmark size={28}/>:<Search size={28}/>}</span><h3>{view==='saved'&&state.saved.length===0?'気になる記事を、ここに。':'該当する記事がありません'}</h3><p>{view==='saved'&&state.saved.length===0?'記事のブックマークを押すと、あとで読むに保存できます。':'検索条件や興味の設定を変えてみてください。'}</p><button className="primary-button" onClick={()=>{setQuery('');setCategory('すべて');setUnreadOnly(false);if(view==='saved')changeView('for-you');}}>記事を見つける<ArrowRight size={15}/></button></div>}
    {filtered.length>visibleLimit&&<LoadMoreSentinel key={visibleLimit} onVisible={loadMore}/>}{filtered.length>visibleLimit&&<button className="load-more-button" onClick={loadMore}>さらに記事を読む<span>残り{filtered.length-visibleLimit}件</span><ChevronDown size={15}/></button>}
    <footer className="feed-footer"><span><Leaf size={13}/>今日は、どんな発見がありましたか。</span></footer>
    </>}
   </div>
   <aside className="insights-column">
    <section className="interest-panel"><div className="panel-heading"><span className="panel-icon"><Sparkles size={17}/></span><h2>あなたの好奇心</h2><button className="icon-button" aria-label="興味を編集" onClick={()=>setModal('preferences')}><SlidersHorizontal size={15}/></button></div><p className="panel-description">あなたらしい発見のために。<br/>気になるトピックを育てましょう。</p><div className="interest-chips">{state.preferences.interests.length?state.preferences.interests.map(t=><button key={t} onClick={()=>{setView('all');setQuery(t);setCategory('すべて');}}>{t}<ArrowUpRight size={11}/></button>):<span className="muted">興味を追加してみましょう</span>}<button className="add-interest" aria-label="興味を追加" onClick={()=>setModal('preferences')}><Plus size={13}/></button></div><div className="interest-divider"/><div className="profile-insight-label"><span>おすすめの学習状況</span><span className="learning-badge">{feedbackCount?'学習中':'はじめの一歩'}</span></div><div className="learning-progress"><span style={{width:`${Math.min(100,12+feedbackCount*8)}%`}}/></div><p className="learning-description">{feedbackCount?`${feedbackCount}件のフィードバックを反映しています。`:'記事の「興味あり」で、好みが伝わります。'}</p><button className="text-link" onClick={()=>setModal('preferences')}>パーソナライズ設定<ArrowRight size={13}/></button></section>
    <section className="today-note"><span className="small-eyebrow">MAKE IT YOURS</span><div className="note-illustration"><div className="note-mini-card"><span/><i/><i/><div><Heart size={15} fill="#d4e5d5"/><Check size={14}/></div></div><span className="note-sparkle one">✦</span><span className="note-sparkle two">✧</span><span className="note-circle"/></div><h3>読むほど、あなたらしく。</h3><p>気になる記事に「興味あり」を。<br/>小さなリアクションが、<br/>次のいい出会いにつながります。</p><button onClick={()=>setModal('preferences')}>おすすめのしくみ<ArrowUpRight size={13}/></button></section>
    <section className="reading-stats"><div><span className="stat-number">{readSet.size}<span>記事</span></span><span>これまでに読んだ記事</span></div><div className="stats-bars">{[18,30,23,44,32,50,38].map((h,i)=><i key={i} style={{height:Math.max(10,h+Math.min(readSet.size,20))}}/> )}</div></section>
    <div className="right-footer"><Logo/><p>情報を、あなたの力に。</p><span>{syncStatus==='synced'?'あなたの好奇心を、どの端末でも。':'オフラインでも、好奇心のつづきを。'}</span></div>
   </aside></main>
  </div>
  {modal==='backup'&&<Modal title="データの移行・バックアップ" onClose={()=>setModal(null)} wide><div className="modal-content"><p>購読・保存・好み・ノート・AI結果と、保存・メモ・AI回答で参照している記事（その既読を含む）をまとめて移行できます。それ以外の記事（90日分のバックログ）とその既読は含まれません。読み込む前に、現在のライブラリも書き出しておくと安心です。</p><button className="secondary-button" onClick={exportData} disabled={!ready}><Download size={15}/>現在のバックアップを書き出す</button><LibraryBackupTransfer disabled={!ready||!!conflict} onImport={document=>{setState(document.reader);setIntelligence(document.intelligence);setSelected(null);setModal(null);changeView('all');notify('バックアップを読み込みました');}}/>{conflict&&<p className="form-error">同期の競合を解決してから読み込んでください。</p>}</div></Modal>}
  {modal==='feeds'&&<Modal title="フィードの管理" onClose={()=>setModal(null)} wide><div className="modal-content"><div className="dialog-intro"><span className="dialog-symbol"><Rss size={23}/></span><h3>好きなメディアと、つながろう。</h3><p>RSSまたはAtomフィードのURLから購読できます。</p></div><form className="feed-form" onSubmit={addFeed}><label htmlFor="feed-url">フィードのURL</label><div className="feed-input-row"><input id="feed-url" type="url" value={feedUrl} onChange={e=>{setFeedUrl(e.target.value);setFeedError('');}} placeholder="https://example.com/feed.xml" required/><button className="primary-button" disabled={adding} type="submit">{adding?<LoaderCircle size={16} className="spin"/>:<Plus size={16}/>}<span>{adding?'確認中…':'追加する'}</span></button></div>{feedError&&<p className="form-error" role="alert">{feedError}</p>}</form><FeedTransfer feeds={state.feeds} folders={folders} onImport={onImport}/><FeedOrganizer feeds={state.feeds} folders={folders} fetchStates={fetchStates} showFetchStates={!!ownerId} onTogglePriority={togglePriorityFeed} onRemove={removeFeed} onOrganize={organize} onMoveUnfiled={moveUnfiled} onFolderRenamed={renameCollapsedFolder}/><div className="modal-tip"><Leaf size={16}/><span>フィードは定期的に自動で取得します。保存した記事は購読解除後も残ります。</span></div></div></Modal>}
  {modal==='preferences'&&<Modal title="あなたらしいおすすめに" onClose={()=>setModal(null)} wide><div className="modal-content preferences-content"><div className="dialog-intro"><span className="dialog-symbol"><Sparkles size={23}/></span><h3>今、気になっていることは？</h3><p>興味と記事へのリアクションから、おすすめの順番が変わります。</p></div><NaturalPreferenceEditor intelligence={intelligence} setIntelligence={setIntelligence} requestAI={requestAI} aiAvailable={aiAvailable} aiBusy={aiBusy} aiStatuses={aiStatuses}/><h3 className="field-heading">興味のあるトピック<span>複数選択できます</span></h3><div className="topic-options">{TOPICS.map(t=><button key={t} className={state.preferences.interests.includes(t)?'chosen':''} aria-pressed={state.preferences.interests.includes(t)} onClick={()=>toggleInterest(t)}>{state.preferences.interests.includes(t)?<Check size={14}/>:<Plus size={14}/>}{t}</button>)}</div><div className="diversity-label"><h3 className="field-heading">メディア・話題の多様性</h3><strong>{state.preferences.diversity}%</strong></div><input className="diversity-slider" aria-label="おすすめの多様性" type="range" min="0" max="100" value={state.preferences.diversity} onChange={e=>setState(s=>({...s,preferences:{...s.preferences,diversity:Number(e.target.value)}}))}/><div className="range-labels"><span>関心の強い記事を優先</span><span>メディアや話題を分散</span></div><h3 className="field-heading muted-heading">表示を控えるトピック</h3><div className="muted-topic-options">{TOPICS.filter(t=>!state.preferences.interests.includes(t)).map(t=><button key={t} className={state.preferences.mutedTopics.includes(t)?'chosen':''} aria-pressed={state.preferences.mutedTopics.includes(t)} onClick={()=>setState(s=>({...s,preferences:{...s.preferences,mutedTopics:s.preferences.mutedTopics.includes(t)?s.preferences.mutedTopics.filter(x=>x!==t):[...s.preferences.mutedTopics,t]}}))}>{state.preferences.mutedTopics.includes(t)&&<X size={11}/ >}{t}</button>)}</div><div className="recommendation-explanation"><Sparkles size={18}/><div><strong>おすすめのしくみ</strong><p>記事のトピックと興味の一致、リアクション、記事の新しさ、メディアの多様性からおすすめ度を計算します。数値はあなたに合う度合いの目安です。「AIで選び直す」では、記事の内容とあなたの指示を生成AIが評価します。通常の閲覧はローカルの推薦でも動作します。AIを使う操作では、対象記事・好み・質問を、選んだ提供元のAIに送信します。</p></div></div><div className="modal-bottom"><button className="text-link muted" onClick={()=>{setState(s=>({...s,feedback:{},preferences:{...s.preferences,topicWeights:{},sourceWeights:{}}}));notify('フィードバックの学習履歴をリセットしました');}}>学習履歴をリセット</button><button className="primary-button" onClick={()=>{setModal(null);notify('あなたの好みをおすすめに反映しました');}}>設定を反映<Check size={16}/></button></div></div></Modal>}
  {selected&&<Modal title="記事を読む" onClose={()=>setSelected(null)} drawer><div className="drawer-content">{safeUrl(selected.image)&&<img className="drawer-cover" src={selected.image} alt=""/>}<div className="drawer-meta"><span>{selected.sourceName}</span><span>·</span><span>{relativeTime(selected.publishedAt)}</span><span>·</span><span>{selected.readingMinutes}分で読めます</span></div>{selected.isSample&&<span className="sample-label">サンプル記事</span>}<h2 className="drawer-title">{selected.title}</h2><div className="drawer-tags">{selected.tags.map(t=><span key={t}>{t}</span>)}</div><div className="drawer-reading-controls"><span><CheckCheck size={14}/>既読</span><button className="secondary-button" onClick={()=>{markUnread(selected);setSelected(null);}}><Inbox size={15}/>未読に戻す</button></div><div className="drawer-recommendation"><Sparkles size={16}/><span>{ranked.find(a=>a.id===selected.id)?.reason||'あなたのライブラリに保存された記事'}</span></div><ArticleReader key={selected.id} article={selected} intelligence={intelligence} setIntelligence={setIntelligence} onArticleUpdate={a=>{const article=toArticle(a);setSelected(article);setState(s=>s.articles.some(x=>x.id===a.id)?{...s,articles:s.articles.map(x=>x.id===a.id?article:x)}:s);if(!libraryIds.has(a.id)&&backlogOwner&&article.content)void saveContent(backlogOwner,a.id,article.content,article.contentFetchedAt||new Date().toISOString());}} onEnsureSaved={()=>{setState(s=>retainArticle({...s,saved:s.saved.includes(selected.id)?s.saved:[...s.saved,selected.id]},selected));retainContent(selected);}}/>{selected.isSample&&<p className="sample-note">これは操作を体験するためのサンプルです。「フィードを更新」で実際の記事を取得できます。</p>}<div className="drawer-actions"><a className="primary-button" href={safeUrl(selected.url)} target="_blank" rel="noopener noreferrer">{selected.isSample?'メディアのサイトへ':'元の記事を読む'}<ExternalLink size={15}/></a><button className="secondary-button" onClick={()=>save(selected)}>{state.saved.includes(selected.id)?<BookmarkCheck size={17}/>:<Bookmark size={17}/ >}{state.saved.includes(selected.id)?'保存済み':'あとで読む'}</button></div><div className="feedback-box"><h3>この記事、あなたの興味に合いましたか？</h3><p>リアクションは次のおすすめに反映されます。</p><div><button className={state.feedback[selected.id]==='like'?'feedback-button chosen':'feedback-button'} aria-pressed={state.feedback[selected.id]==='like'} onClick={()=>feedback(selected,'like')}><ThumbsUp size={16}/>興味あり</button><button className="feedback-button" onClick={()=>feedback(selected,'dislike')}><ThumbsDown size={16}/>興味なし</button></div></div></div></Modal>}
  {conflict&&<Modal title="別の端末で変更されています" onClose={()=>{}} wide><div className="modal-content conflict-content"><span className="dialog-symbol"><Cloud size={24}/></span><h3>残すライブラリを選んでください。</h3><p>変更が重なったため、自動同期を止めています。選ぶ前に、この端末の内容をバックアップできます。</p><button className="text-link" onClick={exportData}><Download size={14}/>この端末のバックアップを書き出す</button><div className="conflict-options"><button className="secondary-button" onClick={()=>void resolveConflict('cloud')}>クラウドの内容を読み込む</button><button className="primary-button" onClick={()=>void resolveConflict('local')}>この端末の内容を同期する</button></div>{syncError&&<p className="connection-note">{syncError}</p>}</div></Modal>}
  {message&&<div className="toast" role="status"><span><Check size={14}/></span>{message}<button className="icon-button" aria-label="通知を閉じる" onClick={()=>setMessage('')}><X size={14}/></button></div>}
 </div>;
}
