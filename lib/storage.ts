import type { Article, Feed, Preferences, ReaderState } from './types.ts';
export const STORAGE_KEY = 'folio.reader.v1';
const record = (v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const strings = (v:unknown):v is string[] => Array.isArray(v)&&v.every(x=>typeof x==='string');
const weights = (v:unknown) => record(v)&&Object.values(v).every(x=>typeof x==='number'&&Number.isFinite(x));
const article = (v:unknown):v is Article => record(v)&&['id','title','description','url','sourceId','sourceName','publishedAt'].every(k=>typeof v[k]==='string')&&strings(v.tags)&&typeof v.readingMinutes==='number'&&Number.isFinite(v.readingMinutes)&&(v.image===undefined||typeof v.image==='string');
const feed = (v:unknown):v is Feed => record(v)&&['id','name','url','website','category','color','initial'].every(k=>typeof v[k]==='string')&&(v.priority===undefined||typeof v.priority==='boolean');
const preferences = (v:unknown):v is Preferences => record(v)&&strings(v.interests)&&strings(v.mutedTopics)&&weights(v.topicWeights)&&weights(v.sourceWeights)&&typeof v.diversity==='number'&&Number.isFinite(v.diversity);
export function decodeState(raw:string|null,fallback:ReaderState):ReaderState {
  if(!raw)return fallback;
  try { const d:unknown=JSON.parse(raw);
    if(!record(d)||d.version!==1||!Array.isArray(d.articles)||!d.articles.every(article)||!Array.isArray(d.feeds)||!d.feeds.every(feed)||!strings(d.saved)||!strings(d.read)||!preferences(d.preferences)||!record(d.feedback)||!Object.values(d.feedback).every(x=>x==='like'||x==='dislike')||!(d.lastUpdated===null||typeof d.lastUpdated==='string'))return fallback;
    return d as unknown as ReaderState;
  }catch{return fallback;}
}
export function mergeArticles(existing:Article[],incoming:Article[],savedIds:string[]):Article[] {
  const updatedSources=new Set(incoming.map(a=>a.sourceId));
  const saved=new Set(savedIds);
  const kept=existing.filter(a=>saved.has(a.id)||!updatedSources.has(a.sourceId));
  const previousByUrl=new Map(existing.map(a=>[a.url,a]));
  const seen=new Set<string>();
  return [...incoming,...kept].filter(a=>{if(seen.has(a.url))return false;seen.add(a.url);return true;}).map(a=>{const old=previousByUrl.get(a.url);return {...a,id:old?.id||a.id,...(a.content===undefined&&old?.content?{content:old.content,contentFetchedAt:old.contentFetchedAt}: {})};});
}
export function mergeSubscribedArticles(existing:Article[],incoming:Article[],savedIds:string[],activeSourceIds:string[]):Article[]{
  const active=new Set(activeSourceIds);
  return mergeArticles(existing,incoming.filter(a=>active.has(a.sourceId)),savedIds);
}
