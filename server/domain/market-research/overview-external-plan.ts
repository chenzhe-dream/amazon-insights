import {OverviewExternalInputSchema,type OverviewExternalInput} from '../../../shared/market-overview-external';
import type {MarketModuleRunView,MarketStepDefinition} from '../../db/market-module-execution-repository';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {overviewIndustryDemandDefinition} from './overview-flow';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export function overviewExternalDefinition(input:OverviewExternalInput):MarketStepDefinition{
 const parsed=OverviewExternalInputSchema.parse(input);
 return {stepKey:`overview-external/${digest(parsed)}`,kind:'collect-overview-month',subject:{flow:'market-overview-flow/rules-v4'},input:parsed,inputRefs:[{kind:'step-output',id:parsed.catalogAttemptId}]};
}
export function overviewExternalFrontier(view:MarketModuleRunView,catalogAttemptId:string){
 const children:MarketStepDefinition[]=[],currentStepKeys:string[]=[],externalAttemptIds:string[]=[];
 const catalog=view.attempts.find(a=>a.id===catalogAttemptId),asins=obj(catalog?.output).externalAsins;
 if(!Array.isArray(asins)||asins.some(a=>typeof a!=='string'||!/^[A-Z0-9]{10}$/.test(a))||asins.length>2000)throw new TypeError('External ASIN manifest missing');
 const include=(definition:MarketStepDefinition)=>{
  currentStepKeys.push(definition.stepKey);const saved=view.steps.find(s=>s.stepKey===definition.stepKey);
  if(!saved){children.push(definition);return null;}
  if(saved.inputHash!==digest(definition))throw new TypeError('External definition differs');
  // Keep the previous immutable result visible during explicit and automatic retries.
  return [...view.attempts].filter(a=>a.stepId===saved.id&&['succeeded','empty','failed','interrupted'].includes(a.status)).at(-1)??null;
 };
 const demand=include(overviewIndustryDemandDefinition(view,catalogAttemptId));
 for(const kind of ['sales','prices'] as const){const a=include(overviewExternalDefinition({phase:'overview-external',catalogAttemptId,kind}));if(a)externalAttemptIds.push(a.id);}
 for(let batch=0;batch*40<asins.length;batch++){
  const requested=asins.slice(batch*40,batch*40+40) as string[],matched=new Set<string>();
  for(let page=1;page<=50;page++){
   const a=include(overviewExternalDefinition({phase:'overview-external',catalogAttemptId,kind:'profits',batch,page,asins:requested}));
   if(!a)break;externalAttemptIds.push(a.id);
   if(!['succeeded','empty'].includes(a.status))break;
   for(const asin of Object.keys(obj(obj(a.output).items)))if(requested.includes(asin))matched.add(asin);
   if(matched.size===requested.length||page>=Number(obj(a.output).pages))break;
  }
 }
 return {children,currentStepKeys,externalAttemptIds,industryDemandAttemptId:demand?.id};
}
