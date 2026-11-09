'use client';
import { useState } from 'react';
import { CheckCheck, LoaderCircle } from 'lucide-react';
import { chunk, sendReadBatches } from '@/lib/backlog/view';
import { MAX_READ_BATCH } from '@/lib/backlog/constants';
import { Modal } from './modal';
import './mark-all-read.css';

type Failure = { remaining: string[][] };

/**
 * 表示中の一覧の未読をまとめて既読にする。確認してから1,000件ずつ送り、途中で失敗したら
 * 送れた件数を示して、残りを再試行できるようにする（送れた分は既読のまま）。
 */
export function MarkAllRead({unreadIds,send,onDone,disabled=false}:{unreadIds:string[];send:(batch:string[])=>Promise<boolean>;onDone:(count:number)=>void;disabled?:boolean}){
 // 確認を開いた時点の対象。送信中に一覧が変わっても対象は変えない。
 const [target,setTarget]=useState<string[]|null>(null);
 const [sending,setSending]=useState(false);
 const [sent,setSent]=useState(0);
 const [failure,setFailure]=useState<Failure|null>(null);
 const close=()=>{if(sending)return;setTarget(null);setFailure(null);setSent(0);};
 const run=async(batches:string[][],already:number)=>{
  setSending(true);setFailure(null);
  let progress=already;
  const result=await sendReadBatches(batches,async batch=>{const ok=await send(batch);if(ok){progress+=batch.length;setSent(progress);}return ok;});
  setSending(false);
  if(result.failedAt===null){setTarget(null);setSent(0);onDone(progress);return;}
  setFailure({remaining:batches.slice(result.failedAt)});
 };
 const start=()=>{if(!target)return;setSent(0);void run(chunk(target,MAX_READ_BATCH),0);};
 const retry=()=>{if(failure)void run(failure.remaining,sent);};
 const remaining=failure?failure.remaining.reduce((sum,batch)=>sum+batch.length,0):0;
 return <>
  <button type="button" className="mark-all-read-button" disabled={disabled||!unreadIds.length} onClick={()=>{setTarget(unreadIds);setFailure(null);setSent(0);}}><CheckCheck size={13}/>すべて既読にする{unreadIds.length>0&&<span className="mark-all-read-count">{unreadIds.length}</span>}</button>
  {target&&<Modal title="すべて既読にする" onClose={close}><div className="modal-content mark-all-read-dialog">
   <p>表示中の未読{target.length}件を既読にします。</p>
   {sending&&<p className="mark-all-read-status" role="status"><LoaderCircle size={14} className="spin"/>既読にしています…（{sent}/{target.length}件）</p>}
   {failure&&!sending&&<p className="form-error" role="alert">{sent}件を既読にしました。残り{remaining}件は送信できませんでした。接続を確認して、もう一度お試しください。</p>}
   <div className="modal-bottom"><button type="button" className="text-link" disabled={sending} onClick={close}>キャンセル</button>{failure?<button type="button" className="primary-button" disabled={sending} onClick={retry}>再試行</button>:<button type="button" className="primary-button" disabled={sending} onClick={start}>既読にする</button>}</div>
  </div></Modal>}
 </>;
}
