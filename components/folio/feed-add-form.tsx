'use client';
import { useState } from 'react';
import { Check, LoaderCircle, Plus } from 'lucide-react';
import type { Feed } from '@/lib/types';
import { feedLookupPath, isSubscribed, parseFeedAddResponse, type FeedCandidate } from '@/lib/feed-add';
import './feed-add-form.css';

const FORM = 'form';

/**
 * フィードの追加欄。RSS / AtomのURLのほか、サイトのURLも受け付ける。サーバーがページのフィードの指定を探し、
 * 1つならそのまま追加し、2つ以上なら候補を並べて選んでもらう。候補の title は文字として表示するだけ。
 * notice は画面の別の操作（優先して取得の上限など）からのお知らせで、追加欄の下に表示する。onEdit で消す。
 */
export function FeedAddForm({feeds,onAdd,notice='',onEdit}:{feeds:Feed[];onAdd:(feed:Feed)=>void;notice?:string;onEdit?:()=>void}){
 const [url,setUrl]=useState('');
 const [error,setError]=useState('');
 // 問い合わせ中のもの。追加欄なら FORM、候補なら候補のURL。
 const [pending,setPending]=useState<string|null>(null);
 const [found,setFound]=useState<{page:string;candidates:FeedCandidate[]}|null>(null);
 const lookup=async(target:string,discover:boolean,marker:string)=>{
  setPending(marker);setError('');
  try{
   const response=await fetch(feedLookupPath(target,discover));
   const result=parseFeedAddResponse(response.ok,await response.json().catch(()=>null));
   if(result.kind==='error')throw new Error(result.message);
   if(result.kind==='candidates'){setFound({page:result.page,candidates:result.candidates});return;}
   if(isSubscribed(feeds,result.feed.url))throw new Error('このフィードはすでに購読しています。');
   setUrl('');setFound(null);onAdd(result.feed);
  }catch(err){setError(err instanceof Error?err.message:'フィードを取得できませんでした。');}finally{setPending(null);}
 };
 const submit=(e:React.FormEvent)=>{
  e.preventDefault();if(pending!==null)return;setError('');setFound(null);onEdit?.();
  let normalized:string;try{normalized=new URL(url.trim()).href;}catch{setError('https:// から始まるURLを入力してください。');return;}
  if(isSubscribed(feeds,normalized)){setError('このフィードはすでに購読しています。');return;}
  void lookup(normalized,true,FORM);
 };
 return <>
  <form className="feed-form" onSubmit={submit}><label htmlFor="feed-url">サイトまたはフィードのURL</label><div className="feed-input-row"><input id="feed-url" type="url" value={url} onChange={e=>{setUrl(e.target.value);setError('');setFound(null);onEdit?.();}} placeholder="https://example.com/" required/><button className="primary-button" disabled={pending!==null} type="submit">{pending===FORM?<LoaderCircle size={16} className="spin"/>:<Plus size={16}/>}<span>{pending===FORM?'確認中…':'追加する'}</span></button></div>{(error||notice)&&<p className="form-error" role="alert">{error||notice}</p>}</form>
  {found&&<section className="feed-candidates" aria-label="見つかったフィード">
   <p>このページには{found.candidates.length}件のフィードがあります。購読するものを選んでください。</p>
   <ul>{found.candidates.map(candidate=>{const subscribed=isSubscribed(feeds,candidate.url);return <li key={candidate.url}>
    <div className="feed-candidate-text"><span>{candidate.title||'タイトルなし'}</span><small>{candidate.url}</small></div>
    {subscribed?<span className="feed-candidate-status"><Check size={13}/>購読中</span>:<button type="button" className="secondary-button" disabled={pending!==null} aria-label={`${candidate.title||candidate.url}を追加`} onClick={()=>void lookup(candidate.url,false,candidate.url)}>{pending===candidate.url?<LoaderCircle size={14} className="spin"/>:<Plus size={14}/>}追加</button>}
   </li>;})}</ul>
   <div className="feed-candidates-footer"><button type="button" className="text-link" disabled={pending!==null} onClick={()=>{setFound(null);setError('');}}>キャンセル</button></div>
  </section>}
 </>;
}
