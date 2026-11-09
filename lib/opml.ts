import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Feed } from './types.ts';

const MAX_BYTES=1024*1024;
const MAX_FEEDS=500;
const invalid=()=>new Error('OPMLの形式が正しくありません。公開HTTPSのフィードを含むファイルを選んでください。');

// Keep this browser module free of feed fetching/server dependencies.
function safeUrl(raw:string):boolean {
  if(/[\u0000-\u0020\u007f]/.test(raw)) return false;
  try {
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.username||url.password||url.port) return false;
    const host=url.hostname.toLowerCase().replace(/\.$/,'');
    if(!host||host.includes(':')||!host.includes('.')||/(?:^|\.)(localhost|local|internal|lan|home|home\.arpa|localdomain|corp|test|invalid)$/.test(host)) return false;
    if(/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a,b,c]=host.split('.').map(Number);
      return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||(b===0&&(c===0||c===2))))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
    }
    return host.split('.').every(part=>/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(part));
  } catch { return false; }
}
function normalize(raw:string):string {
  if(!safeUrl(raw)) throw invalid();
  const url=new URL(raw);url.hash='';url.hostname=url.hostname.toLowerCase().replace(/\.$/,'');return url.href;
}
/** Old subscriptions often still use http://. Read them as https:// (Folio only fetches HTTPS feeds). */
function upgradeToHttps(raw:string):string|null {
  if(!/^http:\/\//i.test(raw)) return null;
  try { const url=new URL(raw);url.protocol='https:';return url.href; } catch { return null; }
}
function acceptUrl(raw:string):{url:string;upgraded:boolean}|null {
  if(safeUrl(raw)) return {url:normalize(raw),upgraded:false};
  const upgraded=upgradeToHttps(raw);
  return upgraded&&safeUrl(upgraded)?{url:normalize(upgraded),upgraded:true}:null;
}
export type SkippedFeed = { name:string; url:string; reason:string };
export type OpmlImport = { feeds:Feed[]; skipped:SkippedFeed[]; upgraded:number };
const UNSAFE_REASON='公開されたHTTPSのURLとして読み込めません';
const LIMIT_REASON=`一度に取り込めるのは${MAX_FEEDS}件までです`;
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const list=(value:unknown):unknown[]=>value==null?[]:Array.isArray(value)?value:[value];
const text=(value:unknown):string=>typeof value==='string'?value.trim():'';
function feedId(url:string):string {
  let hash=2166136261;
  for(let i=0;i<url.length;i++) hash=Math.imul(hash^url.charCodeAt(i),16777619);
  return `opml-${(hash>>>0).toString(16)}`;
}

export function parseOpml(xml:string):Feed[] {
  return parseOpmlDetailed(xml).feeds;
}

/** Parses an OPML file. Broken XML or non-OPML rejects the whole file; individual unusable feeds are skipped and reported. */
export function parseOpmlDetailed(xml:string):OpmlImport {
  if(typeof xml!=='string'||new TextEncoder().encode(xml).byteLength>MAX_BYTES) throw new Error('OPMLは1MB以下のファイルを選んでください。');
  if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)||XMLValidator.validate(xml)!==true) throw invalid();
  let parsed:Record<string,unknown>;
  try { parsed=record(new XMLParser({ignoreAttributes:false,parseAttributeValue:false,parseTagValue:false,trimValues:true}).parse(xml)); } catch { throw invalid(); }
  if(!Object.hasOwn(parsed,'opml')) throw invalid();
  const opml=record(parsed.opml);
  if(!Object.hasOwn(opml,'body')) throw invalid();
  const feeds:Feed[]=[];const skipped:SkippedFeed[]=[];const seen=new Set<string>();let visited=0;let upgraded=0;
  const walk=(outlines:unknown,folders:string[],depth:number)=>{
    if(depth>50) throw invalid();
    for(const raw of list(outlines)) {
      if(++visited>5000) throw invalid();
      const outline=record(raw);
      const title=text(outline['@_title'])||text(outline['@_text']);
      const rawUrl=text(outline['@_xmlUrl']);
      if(Object.hasOwn(outline,'@_xmlUrl')) {
        const accepted=acceptUrl(rawUrl);
        if(!accepted) skipped.push({name:title||rawUrl,url:rawUrl,reason:UNSAFE_REASON});
        else if(!seen.has(accepted.url)) {
          if(feeds.length>=MAX_FEEDS) skipped.push({name:title||rawUrl,url:accepted.url,reason:LIMIT_REASON});
          else {
            seen.add(accepted.url);
            if(accepted.upgraded) upgraded++;
            const url=accepted.url;
            const name=title||new URL(url).hostname;
            const website=acceptUrl(text(outline['@_htmlUrl']));
            feeds.push({id:feedId(url),name,url,website:website?website.url:new URL(url).origin,category:folders.join(' / ')||'未分類',color:'#507b65',initial:Array.from(name)[0]||'F'});
          }
        }
      }
      if(outline.outline!==undefined) walk(outline.outline,rawUrl?folders:title?[...folders,title]:folders,depth+1);
    }
  };
  walk(record(opml.body).outline,[],0);
  return {feeds,skipped,upgraded};
}
function escapeXml(value:string):string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));
}
export function exportOpml(feeds:Feed[]):string {
  if(feeds.length>MAX_FEEDS) throw new Error('一度に書き出せるフィードは500件までです。');
  const categories=new Map<string,Feed[]>();const seen=new Set<string>();
  for(const feed of feeds) {
    const url=normalize(feed.url);
    if(seen.has(url)) continue;
    seen.add(url);
    const category=feed.category||'未分類';
    const entries=categories.get(category)||[];entries.push({...feed,url});categories.set(category,entries);
  }
  const body=[...categories].map(([category,entries])=>`    <outline text="${escapeXml(category)}">\n${entries.map(feed=>`      <outline type="rss" text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" xmlUrl="${escapeXml(feed.url)}" htmlUrl="${escapeXml(safeUrl(feed.website)?normalize(feed.website):new URL(feed.url).origin)}"/>`).join('\n')}\n    </outline>`).join('\n');
  const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Folio フィード</title></head>\n  <body>\n${body}\n  </body>\n</opml>\n`;
  if(new TextEncoder().encode(xml).byteLength>MAX_BYTES) throw new Error('書き出すOPMLが1MBを超えています。');
  return xml;
}
