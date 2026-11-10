'use client';
import { useEffect, useRef, useState } from 'react';
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
 // 追加欄を閉じたら、問い合わせ中の追加をやめる（閉じたあとに届いた応答で購読しない。開き直して同じフィードを2回足さない）。
 const request=useRef<AbortController|null>(null);
 useEffect(()=>()=>request.current?.abort(),[]);
 const lookup=async(target:string,discover:boolean,marker:string)=>{
  const controller=new AbortController();request.current=controller;
  setPending(marker);setError('');
  try{
   const response=await fetch(feedLookupPath(target,discover),{signal:controller.signal});
   const result=parseFeedAddResponse(response.ok,await response.json().catch(()=>null));
   if(controller.signal.aborted)return;
   if(result.kind==='error'){setError(result.message);return;}
   if(result.kind==='candidates'){setFound({page:result.page,candidates:result.candidates});return;}
   if(isSubscribed(feeds,result.feed.url)){setError('このフィードはすでに購読しています。');return;}
   setUrl('');setFound(null);onAdd(result.feed);
  }catch{
   // 通信そのものの失敗。ブラウザーの英語の文言は出さない。
   if(!controller.signal.aborted)setError('フィードを取得できませんでした。通信の状態を確かめて、もう一度お試しください。');
  }finally{if(!controller.signal.aborted)setPending(null);}
 };
 const submit=(e:React.FormEvent)=>{
  e.preventDefault();if(pending!==null)return;setError('');setFound(null);onEdit?.();
  let normalized:string;try{normalized=new URL(url.trim()).href;}catch{setError('https:// から始まるURLを入力してください。');return;}
  if(isSubscribed(feeds,normalized)){setError('このフィードはすでに購読しています。');return;}
  void lookup(normalized,true,FORM);
 };
 // 問い合わせ中は入力を変えられないようにする（届いた結果が、書き換えたあとの入力と食い違わないように）。
 return <>
  <form className="feed-form" onSubmit={submit}><label htmlFor="feed-url">サイトまたはフィードのURL</label><div className="feed-input-row"><input id="feed-url" type="url" value={url} readOnly={pending!==null} onChange={e=>{setUrl(e.target.value);setError('');setFound(null);onEdit?.();}} placeholder="https://example.com/" required/><button className="primary-button" disabled={pending!==null} type="submit">{pending===FORM?<LoaderCircle size={16} className="spin"/>:<Plus size={16}/>}<span>{pending===FORM?'確認中…':'追加する'}</span></button></div>{error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="form-error" role="alert">{notice}</p>}</form>
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
