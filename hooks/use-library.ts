'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { decodeCache, LibrarySyncController, ownerBackupKey, WORKSPACE_BACKUP_KEY, WORKSPACE_KEY, type LibraryView } from '../lib/client-library.ts';
import { STORAGE_KEY } from '../lib/storage.ts';
import type { IntelligenceState } from '../lib/intelligence-types.ts';
import type { ReaderState } from '../lib/types.ts';

export function useLibrary(initialReader:ReaderState) {
  const [initialCache]=useState(()=>decodeCache(null,initialReader).cache);
  const [view,setView]=useState<LibraryView>({cache:initialCache,ready:false,status:'loading',error:'',userName:'',conflict:null,verifiedOwnerId:null});
  const [storageWarning,setStorageWarning]=useState(false);
  // The controller owns the latest reader/intelligence pair, including updates made
  // between React renders and while a network request is still running.
  const controllerRef=useRef<LibrarySyncController|null>(null);

  useEffect(()=>{
    let active=true;
    let initialWarning=false;
    let canPersist=true;
    let raw:string|null=null;
    let legacyRaw:string|null=null;
    try {
      raw=window.localStorage.getItem(WORKSPACE_KEY);
      legacyRaw=window.localStorage.getItem(STORAGE_KEY);
    } catch { initialWarning=true; }
    const decoded=decodeCache(raw,initialCache.document.reader,legacyRaw);
    if(decoded.storageWarning) {
      initialWarning=true;
      // Preserve structurally invalid bytes before creating a usable cache.
      if(raw) {
        try { window.localStorage.setItem(WORKSPACE_BACKUP_KEY,raw); }
        catch { /* The warning remains visible when browser storage is full. */ }
      }
    }
    const persist=(cache:typeof initialCache)=>{
      if(!active||!canPersist)return;
      try { window.localStorage.setItem(WORKSPACE_KEY,JSON.stringify(cache)); }
      catch { setStorageWarning(true); }
    };
    const controller=new LibrarySyncController(decoded.cache,{
      persist,
      fallbackReader:initialCache.document.reader,
      backup:cache=>{
        try { window.localStorage.setItem(cache.ownerId?ownerBackupKey(cache.ownerId):WORKSPACE_BACKUP_KEY,JSON.stringify(cache)); }
        catch {
          // Retain the old main cache if there is no room for its owner backup.
          // The new account remains isolated in memory and receives a warning.
          canPersist=false;setStorageWarning(true);
        }
      },
      restore:ownerId=>{
        try {
          const raw=window.localStorage.getItem(ownerBackupKey(ownerId));
          if(!raw)return null;
          const restored=decodeCache(raw,initialCache.document.reader);
          if(restored.storageWarning) {setStorageWarning(true);return null;}
          return restored.cache.ownerId===ownerId?restored.cache:null;
        } catch {setStorageWarning(true);return null;}
      },
      onChange:next=>{if(active)setView(next);},
    });
    controllerRef.current=controller;
    // Hydrate browser-only storage after the initial server/client render pair.
    queueMicrotask(()=>{
      if(!active)return;
      if(controller.view.ready)setView(controller.view);
      if(initialWarning)setStorageWarning(true);
    });
    void controller.hydrate();
    const online=()=>{void controller.syncNow();};
    const visibility=()=>{if(document.visibilityState==='hidden')void controller.flush();};
    const pagehide=()=>{void controller.flush();};
    window.addEventListener('online',online);
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('pagehide',pagehide);
    return ()=>{
      active=false;
      controller.dispose();
      if(controllerRef.current===controller)controllerRef.current=null;
      window.removeEventListener('online',online);
      document.removeEventListener('visibilitychange',visibility);
      window.removeEventListener('pagehide',pagehide);
    };
  },[initialCache]);

  useEffect(()=>{
    if(!view.ready||!view.cache.pending||view.conflict||!['synced','syncing'].includes(view.status))return;
    const timer=window.setTimeout(()=>{void controllerRef.current?.flush();},1200);
    return ()=>window.clearTimeout(timer);
  },[view.ready,view.cache.document,view.cache.revision,view.cache.pending,view.conflict,view.status]);

  const setState:Dispatch<SetStateAction<ReaderState>>=useCallback(update=>{
    controllerRef.current?.editReader(update);
  },[]);
  const setIntelligence:Dispatch<SetStateAction<IntelligenceState>>=useCallback(update=>{
    controllerRef.current?.editIntelligence(update);
  },[]);
  const snapshot=useCallback(()=>{
    const controller=controllerRef.current;if(!controller)return null;
    const {cache,verifiedOwnerId}=controller.view;
    return {ownerId:verifiedOwnerId,reader:cache.document.reader,intelligence:cache.document.intelligence};
  },[]);
  const syncNow=useCallback(async()=>{await controllerRef.current?.syncNow();},[]);
  const resolveConflict=useCallback(async(choice:'cloud'|'local')=>{await controllerRef.current?.resolveConflict(choice);},[]);

  return {
    state:view.cache.document.reader,
    setState,
    intelligence:view.cache.document.intelligence,
    setIntelligence,
    ready:view.ready,
    syncStatus:view.status,
    syncError:view.error,
    storageWarning,
    userName:view.userName,
    // サーバーで確かめた持ち主のID。確かめる前やログアウト時は null。バックログはこのIDで開く。
    ownerId:view.verifiedOwnerId,
    // オフラインで確かめられないときに端末内のバックログを表示するための、cacheの持ち主。
    cachedOwnerId:view.cache.ownerId??null,
    // いまの同期データと確かめた持ち主を、描画を待たずに読む（移行中の持ち主の確認に使う）。
    snapshot,
    conflict:view.conflict,
    syncNow,
    resolveConflict,
  };
}
