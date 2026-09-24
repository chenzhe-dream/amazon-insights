import {z} from 'zod';
import {SHAPE_CATEGORY_METRICS} from '../../../shared/market-shape-category-contracts';
import type {MarketModuleRunView,MarketStepDefinition,MarketExecutionStep} from '../../db/market-module-execution-repository';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
const flow='market-shape-price-flow/rules-v4';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const success=(s:MarketExecutionStep)=>['succeeded','empty'].includes(s.status);
export function inspectSorftimeShapeContinuation(view:MarketModuleRunView){
 const children:MarketStepDefinition[]=[],currentStepKeys:string[]=[],poolSize=z.number().int().min(1).max(300).parse(obj(view.run.params).poolSize);
 const find=(d:MarketStepDefinition)=>{currentStepKeys.push(d.stepKey);const s=view.steps.find(s=>s.stepKey===d.stepKey);if(s&&s.inputHash!==digest(d))throw Error('Sorftime shape frontier differs');if(!s)children.push(d);return s;};
 const attempt=(s:MarketExecutionStep)=>{const a=view.attempts.find(a=>a.id===s.latestAttemptId&&a.stepId===s.id);if(!a||a.status!==s.status)throw Error('Sorftime shape attempt differs');return a;};
 const anchor=find({stepKey:'shape-flow/anchor',kind:'collect-shape-pool',subject:{flow},input:{poolSize},inputRefs:[]});
 if(!anchor||!success(anchor))return {children,currentStepKeys};
 const a=attempt(anchor),basis=obj(a.output),pages=[a];
 const categoryName=z.string().nullable().parse(basis.categoryName);
 if(poolSize>100&&categoryName){
  const maxPages=Math.min(20,Math.ceil((poolSize-100)/15)+2);const selected=new Set(z.array(z.string()).parse(basis.productAsins));
  for(let page=1;page<=maxPages&&selected.size<poolSize;page++){
   const p=find({stepKey:`shape-v4/page:${digest({anchor:a.id,page})}`,kind:'collect-shape-pool',subject:{flow,page},input:{poolSize,page,categoryName,referenceAttemptId:a.id},inputRefs:[{kind:'step-output',id:a.id}]});
   if(!p||!success(p))return {children,currentStepKeys};const done=attempt(p);pages.push(done);for(const asin of z.array(z.string()).parse(obj(done.output).productAsins))selected.add(asin);
   if(z.number().parse(obj(done.output).receivedCount)<20)break;
  }
 }
 const selected=find({stepKey:`shape-v4/select:${digest(pages.map(p=>p.id))}`,kind:'prepare-members',subject:{flow},input:{phase:'select-sorftime-shape-members',referenceAttemptId:a.id,pageAttemptIds:pages.map(p=>p.id)},inputRefs:pages.map(p=>({kind:'step-output' as const,id:p.id}))});
 if(!selected||!success(selected))return {children,currentStepKeys};const s=attempt(selected),selection=obj(s.output),selectionInputSnapshotId=z.string().parse(selection.selectionInputSnapshotId),asins=z.array(z.string().regex(/^[A-Z0-9]{10}$/)).max(300).parse(selection.selectedAsins);
 for(const metric of SHAPE_CATEGORY_METRICS)find({stepKey:`shape-v4/category:${digest({selection:s.id,metric})}`,kind:'collect-shape-category',subject:{flow,metric},input:{metric,selectionInputSnapshotId},inputRefs:[{kind:'input',id:selectionInputSnapshotId}]});
 for(const asin of asins)for(const kind of ['collect-product-history','collect-product-amount-history','collect-product-image'] as const)find({stepKey:`shape-v4/${kind}:${digest({selection:s.id,asin})}`,kind,subject:{flow,asin},input:{asin,selectionInputSnapshotId},inputRefs:[{kind:'input',id:selectionInputSnapshotId}]});
 return {children,currentStepKeys};
}
