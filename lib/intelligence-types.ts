import type { Article, ReaderState } from './types.ts';
import type { Effort, ProviderId } from './ai/types.ts';
export interface NaturalProfile { summary:string; boostTerms:string[]; muteTerms:string[]; preferredDepth:'any'|'introductory'|'practical'|'advanced'; }
export interface ArticleAnalysis { articleId:string; interest:number; importance:number; summary:string; reason:string; importanceReason:string; }
export interface ArticleNote { id:string; articleId:string; quote:string; body:string; createdAt:string; updatedAt:string; }
export interface DigestItem { articleId:string; summary:string; takeaway:string; minutes:number; }
export interface DigestResult { title:string; overview:string; items:DigestItem[]; totalMinutes:number; generatedAt:string; mode:'ai'|'extractive'; }
export interface StoryReport { overview:string; developments:{text:string;articleIds:string[]}[]; perspectives:{sourceName:string;point:string;articleIds:string[]}[]; uncertainties:string[]; }
export interface LibraryAnswer { answer:string; citations:{articleId:string;quote:string}[]; }
export interface LibraryChat { id:string; question:string; result:LibraryAnswer; createdAt:string; }
export type AISettings = { provider:ProviderId; models:Partial<Record<ProviderId,string>>; efforts:Partial<Record<ProviderId,Effort>> };
export interface IntelligenceState { version:1; instructions:string; profile:NaturalProfile|null; analysis:Record<string,ArticleAnalysis>; notes:ArticleNote[]; exploration:number; digestMinutes:number; digest:DigestResult|null; storyReports:Record<string,StoryReport>; chats:LibraryChat[]; ai?:AISettings; }
export interface SyncDocument { version:2; reader:ReaderState; intelligence:IntelligenceState; updatedAt:string; }
export interface CloudLibrary { document:SyncDocument|null; revision:number; updatedAt:string|null; userName?:string; ownerId?:string; }
export type AIRequest = { action:'analyze'|'preferences'|'digest'|'compare'|'ask'; articles:Article[]; instruction?:string; question?:string; budgetMinutes?:number; readIds?:string[]; notes?:ArticleNote[]; provider?:ProviderId; model?:string; effort?:Effort; };
export type AIResult = {kind:'analyze';analysis:ArticleAnalysis[]}|{kind:'preferences';profile:NaturalProfile}|{kind:'digest';digest:DigestResult}|{kind:'compare';report:StoryReport}|{kind:'ask';result:LibraryAnswer};
export const DEFAULT_INTELLIGENCE:IntelligenceState={version:1,instructions:'',profile:null,analysis:{},notes:[],exploration:20,digestMinutes:5,digest:null,storyReports:{},chats:[]};
