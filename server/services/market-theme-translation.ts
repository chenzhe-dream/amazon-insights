import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MarketExecutionActor } from '../db/market-module-execution-repository';
import { MarketThemeReportService } from './market-theme-report-service';
import { restoreMarketThemeDetails } from '../domain/market-research/customer-theme-details';
import { MarketThemeTranslationResponseSchema, MarketThemeTranslationQuerySchema, MarketThemeTranslationStartSchema, type MarketThemeTranslationItem } from '../../shared/market-theme-translation-contracts';
import { canonicalJsonSha256 as digest } from '../runtime/model-request-accounting';

const itemKey=z.object({itemId:z.string(),field:z.enum(['group-label','group-definition','member-keyword','member-content','asin-summary']),original:z.string()}).strict();
type SourceItem=z.infer<typeof itemKey>;
export type TranslationSource={organizationId:string;moduleRunId:string;attemptId:string;reportHash:string;item:SourceItem};
const hasChinese=(value:string)=>/[\u4e00-\u9fff]/.test(value);
const numbers=(value:string)=>(value.match(/\d+(?:\.\d+)?/g)??[]).map(Number);
function validate(original:string,translated:string){
 if(!translated.trim()||translated.length>20000||!hasChinese(translated))throw new Error('中文翻译校验未通过');
 const source=new Set(numbers(original)),result=new Set(numbers(translated));
 if([...source].some(value=>!result.has(value))||[...result].some(value=>!source.has(value)))throw new Error('翻译改变了数字参数');
 return translated.trim();
}

/** Report-bound translation cache. Reads never call the model; POST retries only selected failed items. */
export class MarketThemeTranslationService {
 private readonly jobs=new Map<string,Promise<void>>(); private tail:Promise<void>=Promise.resolve();
 constructor(private readonly options:{root:string;modelIdentity:string;resolveReport:MarketThemeReportService;readSelection?:(actor:MarketExecutionActor,moduleRunId:string,attemptId:string)=>Promise<{samples:readonly {asin:string;customerSay:{value:string|null}}[]} | null>;translate:(source:TranslationSource,sourceHash:string)=>Promise<string>}){}
 private async sources(actor:MarketExecutionActor,moduleRunId:string,attemptId:string,reportHash:string){
  const resolved=await this.options.resolveReport.resolveReport({actor,moduleRunId,attemptId});
  if(!resolved||resolved.entry.report.reportHash!==reportHash) return null;
  const restored=restoreMarketThemeDetails(resolved.snapshot,resolved.entry.report.basis==='empty-selection',resolved.priorEvaluations);
  const labels=new Map(restored.labels.map(label=>[label.groupId,label]));
  const items:SourceItem[]=[];
  restored.aggregation.groups.forEach((group,index)=>{
   const label=group.groupId?labels.get(group.groupId)?.labelZh:null;
   const original=label??group.members[0]?.keyword??'';
   if(original)items.push({itemId:`group:${index}:label`,field:'group-label',original});
   if(label&&labels.get(group.groupId!)?.definition)items.push({itemId:`group:${index}:definition`,field:'group-definition',original:labels.get(group.groupId!)!.definition});
  });
  for(const member of restored.aggregation.perAsin.flatMap(asin=>asin.themes)){
   if(member.keyword)items.push({itemId:`member:${member.sourceThemeId}:keyword`,field:'member-keyword',original:member.keyword});
   if(member.content)items.push({itemId:`member:${member.sourceThemeId}:content`,field:'member-content',original:member.content});
  }
  const selection=await this.options.readSelection?.(actor,moduleRunId,attemptId);
  for(const sample of selection?.samples??[])if(sample.customerSay.value)items.push({itemId:`asin:${sample.asin}:summary`,field:'asin-summary',original:sample.customerSay.value});
  return {entry:resolved.entry,items,source:{organizationId:actor.organizationId,moduleRunId,attemptId,reportHash}};
 }
 private hash(source:TranslationSource){return createHash('sha256').update(JSON.stringify(['market-theme-translation/v1',this.options.modelIdentity,source.organizationId,source.moduleRunId,source.attemptId,source.reportHash,source.item.itemId,source.item.original])).digest('hex');}
 private readCache(source:TranslationSource):MarketThemeTranslationItem{
  const sourceHash=this.hash(source),empty:MarketThemeTranslationItem={itemId:source.item.itemId,field:source.item.field,language:'zh-CN',translationVersion:'market-theme-translation/v1',sourceHash,original:source.item.original,translated:null,state:'missing',message:null};
  try{
   const cached=JSON.parse(readFileSync(join(this.options.root,sourceHash+'.json'),'utf8')) as {savedAt?:number;item?:unknown};
   const item=MarketThemeTranslationResponseSchema.shape.items.element.parse(cached.item);
   if(item.sourceHash!==sourceHash||item.original!==source.item.original||item.itemId!==source.item.itemId)return empty;
   if(item.state==='pending'&&!this.jobs.has(sourceHash)&&Date.now()-Number(cached.savedAt??0)>600000)return {...empty,state:'failed',message:'翻译任务已中断，请重试。'};
   return item;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return {...empty,state:'failed',message:'翻译缓存读取失败，请重试。'};return empty;}
 }
 private save(item:MarketThemeTranslationItem){mkdirSync(this.options.root,{recursive:true});const target=join(this.options.root,item.sourceHash+'.json'),temp=target+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify({savedAt:Date.now(),item}),'utf8');renameSync(temp,target);}
 private async readAll(actor:MarketExecutionActor,moduleRunId:string,attemptId:string,reportHash:string){
  const resolved=await this.sources(actor,moduleRunId,attemptId,reportHash);if(!resolved)return null;
  const source=resolved.source;const items=resolved.items.map(item=>this.readCache({...source,item}));
  return MarketThemeTranslationResponseSchema.parse({report:resolved.entry,items});
 }
 async read(actor:MarketExecutionActor,moduleRunId:string,attemptId:string,query:unknown){const q=MarketThemeTranslationQuerySchema.parse(query);return this.readAll(actor,moduleRunId,attemptId,q.reportHash);}
 async start(actor:MarketExecutionActor,moduleRunId:string,attemptId:string,body:unknown){
  const request=MarketThemeTranslationStartSchema.parse(body),resolved=await this.sources(actor,moduleRunId,attemptId,request.reportHash);if(!resolved)return null;
  const wanted=request.itemIds?new Set(request.itemIds):null;
  for(const item of resolved.items){if(wanted&&!wanted.has(item.itemId))continue;const source={...resolved.source,item},current=this.readCache(source);if(!['missing','failed'].includes(current.state)||this.jobs.has(current.sourceHash))continue;
   const pending={...current,state:'pending' as const,message:null};this.save(pending);
   const task=this.tail.then(async()=>{try{const translated=validate(item.original,await this.options.translate(source,current.sourceHash));this.save({...pending,state:'ready',translated});}catch(error){this.save({...pending,state:'failed',message:error instanceof Error?error.message:'翻译未完成，请重试。'});}}).catch(()=>{}).finally(()=>this.jobs.delete(current.sourceHash));
   this.jobs.set(current.sourceHash,task);this.tail=task;
  }
  return this.readAll(actor,moduleRunId,attemptId,request.reportHash);
 }
 async drain(){await this.tail;}
}
