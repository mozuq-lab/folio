'use client';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({title,children,onClose,wide=false,drawer=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean;drawer?:boolean}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const el=ref.current;el?.showModal();return()=>el?.close();},[]);
 return <dialog ref={ref} aria-label={title} className={`modal ${wide?'modal-wide':''} ${drawer?'article-drawer':''}`} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="閉じる" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}
