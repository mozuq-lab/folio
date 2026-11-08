import type { Article, Feedback, Preferences, RankedArticle } from './types.ts';
import type { IntelligenceState } from './intelligence-types.ts';
import {rankArticles} from './recommendations.ts';
import {applyNaturalProfile,scoreNaturalPreference,scoreImportance} from './discovery.ts';
export interface IntelligentArticle extends RankedArticle { importance:number; importanceReason:string; isExploration:boolean; aiAnalyzed:boolean; aiSummary?:string; interestScore:number; }
const bounded=(v:number)=>Math.min(99,Math.max(0,Math.round(Number.isFinite(v)?v:0)));
export function rankPersonalized(articles:Article[],preferences:Preferences,feedback:Feedback,intelligence:IntelligenceState,includeHidden=false):IntelligentArticle[]{
 const prefs=includeHidden?{...preferences,mutedTopics:[]}:preferences;
 const candidates=includeHidden?articles:applyNaturalProfile(articles,intelligence.profile);
 const ranked=rankArticles(candidates,prefs,includeHidden?{}:feedback);
 return ranked.map(a=>{
  const ai=intelligence.analysis[a.id];const impact=scoreImportance(a,articles);const natural=includeHidden?0:scoreNaturalPreference(a,intelligence.profile);
  const learned=a.tags.reduce((sum,t)=>sum+(prefs.topicWeights[t]||0)*2,0)+(prefs.sourceWeights[a.sourceId]||0)*2;
  const interest=ai?bounded(ai.interest+Math.max(-16,Math.min(16,learned))+(feedback[a.id]==='like'?8:0)):bounded(a.score+natural);
  return {...a,score:interest,interestScore:interest,reason:ai?.reason||(natural>0?'自然文の好みと記事の内容が一致':a.reason),importance:ai?bounded(ai.importance):impact.score,importanceReason:ai?.importanceReason||impact.reason,isExploration:false,aiAnalyzed:!!ai,aiSummary:ai?.summary};
 }).sort((a,b)=>b.interestScore-a.interestScore||(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0)||a.id.localeCompare(b.id));
}
export function mixExploration(ranked:IntelligentArticle[],exploration:Article[],percentage:number):IntelligentArticle[]{
 const ratio=Number.isFinite(percentage)?Math.max(0,Math.min(100,percentage)):0;
 if(!ratio||!exploration.length)return ranked;
 const amount=Math.min(exploration.length,Math.round(10*ratio/100));if(!amount)return ranked;
 const ids=new Set(exploration.slice(0,amount).map(a=>a.id));const normal=ranked.filter(a=>!ids.has(a.id));
 const map=new Map(ranked.map(a=>[a.id,a]));const extra=exploration.slice(0,amount).map(a=>map.get(a.id)?{...map.get(a.id)!,isExploration:true}:{...a,score:0,interestScore:0,reason:'いつもの興味から少し外れた新しい視点',importance:scoreImportance(a,exploration).score,importanceReason:'掲載状況からの推定',isExploration:true,aiAnalyzed:false});
 const result=[...normal];for(let i=0;i<extra.length;i++){const position=Math.min(result.length,Math.max(0,Math.floor((i+1)*10/amount)-1));result.splice(position,0,extra[i]);}return result;
}
/** Cross UI/API/storage boundaries with an explicit article DTO. */
export function toArticle(value:Article):Article {
 const {id,title,description,url,sourceId,sourceName,publishedAt,tags,readingMinutes,image,isSample,content,contentFetchedAt}=value;
 return {id,title,description,url,sourceId,sourceName,publishedAt,tags:[...tags],readingMinutes,...(image!==undefined?{image}:{}),...(isSample!==undefined?{isSample}:{}),...(content!==undefined?{content}:{}),...(contentFetchedAt!==undefined?{contentFetchedAt}:{})};
}
