import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MarketExecutionActor } from '../db/market-module-execution-repository';
import { MarketThemeReportService } from './market-theme-report-service';
import { restoreMarketThemeDetails } from '../domain/market-research/customer-theme-details';
import { marketThemeLanguage, MarketThemeTranslationResponseSchema, MarketThemeTranslationQuerySchema, MarketThemeTranslationStartSchema, type MarketThemeTranslationItem } from '../../shared/market-theme-translation-contracts';
import { fixedThemeTranslation, MarketThemeTranslationMemory, THEME_TRANSLATION_POLICY } from './market-theme-translation-memory';

const itemKey=z.object({itemId:z.string(),field:z.enum(['group-label','group-definition','member-keyword','member-content','asin-summary']),original:z.string()}).strict();
type SourceItem=z.infer<typeof itemKey>;
export type TranslationSource={organizationId:string;moduleRunId:string;attemptId:string;reportHash:string;language:MarketThemeTranslationItem['language'];item:SourceItem};
const numbers=(value:string)=>(value.match(/\d+(?:\.\d+)?/g)??[]).map(Number);
function validate(original:string,translated:string,language:TranslationSource['language']){
 if(!translated.trim()||translated.length>20000)throw new Error('翻译结果为空或超出长度限制');
 const script=language==='zh-CN'?/[\u4e00-\u9fff]/:language==='ja-JP'?/[\u3040-\u30ff\u4e00-\u9fff]/:/[A-Za-zÀ-ž]/;
 if(!script.test(translated))throw new Error('翻译结果未包含目标语言文字');
 const source=new Set(numbers(original)),result=new Set(numbers(translated));
 if([...source].some(value=>!result.has(value))||[...result].some(value=>!source.has(value)))throw new Error('翻译改变了数字参数');
 return translated.trim();
}

/** Report-bound status plus persistent exact-text memory. Reads never call the model. */
export class MarketThemeTranslationService {
 private readonly jobs=new Map<string,Promise<void>>(); private tail:Promise<void>=Promise.resolve();
 private readonly contentJobs=new Map<string,Promise<string>>();
 private readonly memory:MarketThemeTranslationMemory;
 constructor(private readonly options:{root:string;modelIdentity:string;resolveReport:MarketThemeReportService;readSelection?:(actor:MarketExecutionActor,moduleRunId:string,attemptId:string)=>Promise<{samples:readonly {asin:string;customerSay:{value:string|null}}[]} | null>;translate:(source:TranslationSource,sourceHash:string)=>Promise<string>}){this.memory=new MarketThemeTranslationMemory(options.root,options.modelIdentity);}
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
  return {entry:resolved.entry,items,source:{organizationId:actor.organizationId,moduleRunId,attemptId,reportHash,language:marketThemeLanguage(resolved.entry.report.scope.marketplace).code}};
 }
 private hash(source:TranslationSource,legacy=false){return createHash('sha256').update(JSON.stringify([legacy?'market-theme-translation/v2':'market-theme-translation/v3',source.language,this.options.modelIdentity,source.organizationId,source.moduleRunId,source.attemptId,source.reportHash,source.item.itemId,source.item.original,...(legacy?[]:[THEME_TRANSLATION_POLICY])])).digest('hex');}
 private readCache(source:TranslationSource):MarketThemeTranslationItem{
  const sourceHash=this.hash(source),empty:MarketThemeTranslationItem={itemId:source.item.itemId,field:source.item.field,language:source.language,translationVersion:'market-theme-translation/v3',sourceHash,original:source.item.original,translated:null,state:'missing',message:null};
  const fixed=fixedThemeTranslation(source);
  if(fixed!==null)return {...empty,state:'ready',translated:fixed};
  let fallback=empty;
  for(const legacy of [false,true])try{
   const key=this.hash(source,legacy),cached=JSON.parse(readFileSync(join(this.options.root,key+'.json'),'utf8')) as {savedAt?:number;item?:unknown};
   const item=MarketThemeTranslationResponseSchema.shape.items.element.parse(cached.item);
   if(item.language!==source.language||item.translationVersion!==(legacy?'market-theme-translation/v2':'market-theme-translation/v3')||item.sourceHash!==key||item.original!==source.item.original||item.itemId!==source.item.itemId||item.field!==source.item.field)continue;
   if(item.state==='ready'&&item.translated)return {...empty,state:'ready',translated:validate(source.item.original,item.translated,source.language)};
   if(!legacy)fallback=item.state==='pending'&&!this.jobs.has(sourceHash)&&Date.now()-Number(cached.savedAt??0)>600000?{...empty,state:'failed',message:'翻译任务已中断，请重试。'}:item;
  }catch(error){if(!legacy&&(error as NodeJS.ErrnoException).code!=='ENOENT')fallback={...empty,state:'failed',message:'翻译缓存读取失败，请重试。'};}
  const stored=this.memory.read(source);
  if(stored!==null)try{return {...empty,state:'ready',translated:validate(source.item.original,stored,source.language)};}catch{/* Invalid content is regenerated only by an explicit start. */}
  return fallback;
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
  for(const item of resolved.items){if(wanted&&!wanted.has(item.itemId))continue;const source={...resolved.source,item},current=this.readCache(source);
   if(current.state==='ready'&&current.translated!==null){if(fixedThemeTranslation(source)===null)this.memory.save(source,current.translated);continue;}
   if(!['missing','failed'].includes(current.state)||this.jobs.has(current.sourceHash))continue;
   const pending={...current,state:'pending' as const,message:null};this.save(pending);
   const key=this.memory.key(source);
   let work=this.contentJobs.get(key);
   if(!work){
    work=this.tail.then(async()=>{
     const cached=this.memory.read(source);
     if(cached!==null)try{return validate(item.original,cached,source.language);}catch{/* Recompute invalid cache. */}
     const translated=validate(item.original,await this.options.translate(source,current.sourceHash),source.language);
     this.memory.save(source,translated);return translated;
    });
    this.contentJobs.set(key,work);this.tail=work.then(()=>{},()=>{});
    void work.then(()=>this.contentJobs.delete(key),()=>this.contentJobs.delete(key));
   }
   const task=work.then(translated=>this.save({...pending,state:'ready',translated}),error=>this.save({...pending,state:'failed',message:(error instanceof Error?error.message:'翻译未完成，请重试。').slice(0,240)})).catch(()=>{}).finally(()=>this.jobs.delete(current.sourceHash));
   this.jobs.set(current.sourceHash,task);
  }
  return this.readAll(actor,moduleRunId,attemptId,request.reportHash);
 }
 async drain(){await this.tail;await Promise.all(this.jobs.values());}
}
