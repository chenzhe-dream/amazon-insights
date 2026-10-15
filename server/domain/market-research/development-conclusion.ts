import {DevelopmentConclusionSchema,type DevelopmentConclusion,type ConclusionEvidence} from '../../../shared/market-development-conclusion';
type Scope=DevelopmentConclusion['scope'];
const names={overview:'市场总览',shapes:'商品形态及价格带',keywords:'类目关键词洞察',themes:'买家评论见解'};
export function sameConclusionScope(a:Scope,b:Scope){return a.marketplace===b.marketplace&&a.nodeIdPath.split(':').at(-1)===b.nodeIdPath.split(':').at(-1)&&a.fromMonth===b.fromMonth&&a.toMonth===b.toMonth;}
export function reviewDevelopmentEvidence(input:{scope:Scope;runId:string|null;identity:string|null;selectedCount:number;successfulCount:number;requestedCount:number;groups:Array<{label:string;positive:number;negative:number;mention:number;share:number|null;asins:string[];refs:string[]}>;gaps:string[]}):ConclusionEvidence{
 const groups=input.groups.filter(g=>g.mention>0),ranked=[...groups].sort((a,b)=>b.mention-a.mention);
 return {module:'themes',runId:input.runId,identity:input.identity,scope:input.scope,status:!groups.length?'missing':input.gaps.length||input.successfulCount<input.selectedCount?'partial':'ready',
 facts:[`所选 ${input.selectedCount} 个商品，有效摘要 ${input.successfulCount} 个；原计划样本 ${input.requestedCount} 个。`,...ranked.slice(0,6).map(g=>`${g.label}：主题提及 ${g.mention} 次${g.share===null?'':`，主题份额 ${g.share.toFixed(1)}%`}；已展示证据商品 ${g.asins.join('、')||'暂无'}。`)],
 findings:ranked.slice(0,6).map(g=>`${g.label}：正向 ${g.positive} 次、负向/分歧 ${g.negative} 次。${g.positive?'将正向体验列为保留候选，验证能否稳定复现。':''}${g.negative?'将负向反馈列为设计风险，核对原摘要后制定测试指标。':''}`),
 gaps:[...input.gaps,...(!groups.length?['未取得有效主题，暂无开发方向']:[])],refs:[...new Set(groups.flatMap(g=>g.refs))].slice(0,300)};
}
/** Combines saved evidence only; never calls a provider or infers a score for missing inputs. */
export function buildDevelopmentConclusion(kind:'reviews'|'linked',scope:Scope,inputs:ConclusionEvidence[]):DevelopmentConclusion{
 const evidence=inputs.map(e=>e.scope&&!sameConclusionScope(scope,e.scope)?{...e,status:'mismatch' as const,facts:[],findings:[],refs:[],gaps:['报告范围与当前结论范围不一致，已排除该模块']} : e);
 const expected=kind==='reviews'?['themes']:Object.keys(names);
 for(const module of expected)if(!evidence.some(e=>e.module===module))evidence.push({module:module as ConclusionEvidence['module'],runId:null,identity:null,scope:null,status:'missing',facts:[],findings:[],refs:[],gaps:['尚无绑定的已保存报告']});
 const usable=evidence.filter(e=>e.status==='ready'||e.status==='partial'),known=usable.some(e=>e.findings.length||e.facts.length);
 const sections:DevelopmentConclusion['sections']=usable.flatMap(e=>[
  {title:`${names[e.module]} · 已知依据`,status:'observed' as const,text:e.facts.join('\n')||'暂无可复核的数值事实',refs:e.refs},
  ...(e.findings.length?[{title:`${names[e.module]} · 分析与候选`,status:'candidate' as const,text:e.findings.join('\n'),refs:e.refs}]:[]),
 ]);
 const actions:DevelopmentConclusion['actions']=[];
 const review=usable.find(e=>e.module==='themes'),keyword=usable.find(e=>e.module==='keywords');
 if(review?.findings.length)actions.push({priority:'P1',action:'把正向主题转为必须保留的体验，把负向/分歧主题转为风险测试清单',validation:'逐项查看所列摘要与商品，确认问题机制、适用人群及可量化的样品验收指标；正负提及可能重叠，不能当作独立评论比例。',refs:review.refs});
 if(keyword?.findings.length)actions.push({priority:'P1',action:'验证关键词需求与评论中的产品要求是否指向同一方案',validation:'将关键词形态、功能、场景逐项对照评论证据；未建立明确对应的需求保持待验证，不自动认定为未满足需求。',refs:[...new Set([...keyword.refs,...(review?.refs??[])])].slice(0,300)});
 if(usable.some(e=>e.module==='shapes'))actions.push({priority:'P1',action:'用商品形态及价格带验证方案的供给位置',validation:'核对人工形态标签、所选商品及价格覆盖；价格不是利润，先取得采购与履约成本再验证定价。',refs:usable.find(e=>e.module==='shapes')!.refs});
 actions.push({priority:'P0',action:'完成立项前验证后再作进入决策',validation:'补充采购、运输、平台费用、广告、退货等成本与利润测算，并验证竞争、合规和知识产权；当前结论不包含这些完整证据。',refs:[]});
 const gaps=[...evidence.flatMap(e=>e.gaps.map(g=>`${names[e.module]}：${g}`)),...(kind==='reviews'||review?['Customers Say 是主题聚合；无法评论去重，正负计数可能重叠，主题份额不等于独立评论发生率。']:[]),'最终成本、利润、合规与可执行的竞争验证尚待立项流程确认。'];
 sections.push({title:kind==='reviews'?'类目开发判断':'跨四模块综合判断',status:'pending',text:!known?'当前没有足够的已保存证据，先取得有效报告。':kind==='reviews'?'以上主题可形成体验保留与风险验证候选；仅凭评论不能确认需求规模、竞争空位或利润。':'各模块按同一站点、类目及月份核对后列出依据；当前可据此组织需求、供给与体验验证。不同样本和计量口径不能直接相加，尚未证明这些候选存在共同的商业机会。',refs:[]});
 return DevelopmentConclusionSchema.parse({version:'market-development/20261015.1',kind,scope,status:!known?'no-data':evidence.every(e=>e.status==='ready')?'evidence-ready':'partial',headline:!known?'证据尚未就绪':kind==='reviews'?'评论驱动的类目开发候选与验证计划':'同范围四模块的开发依据与验证计划',evidence,sections,actions,gaps:[...new Set(gaps)].slice(0,220)});
}
