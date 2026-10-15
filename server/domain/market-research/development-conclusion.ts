import {DevelopmentConclusionSchema,type DevelopmentConclusion,type ConclusionEvidence} from '../../../shared/market-development-conclusion';
import {associateDevelopmentEvidence} from './development-association';
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
 let gaps=[...evidence.flatMap(e=>e.gaps.map(g=>`${names[e.module]}：${g}`)),...(kind==='reviews'||review?['Customers Say 是主题聚合；无法评论去重，正负计数可能重叠，主题份额不等于独立评论发生率。']:[]),'最终成本、利润、合规与可执行的竞争验证尚待立项流程确认。'];
 sections.push({title:kind==='reviews'?'类目开发判断':'跨四模块综合判断',status:'pending',text:!known?'当前没有足够的已保存证据，先取得有效报告。':kind==='reviews'?'以上主题可形成体验保留与风险验证候选；仅凭评论不能确认需求规模、竞争空位或利润。':'各模块按同一站点、类目及月份核对后列出依据；当前可据此组织需求、供给与体验验证。不同样本和计量口径不能直接相加，尚未证明这些候选存在共同的商业机会。',refs:[]});
 const decision=kind==='linked'?associateDevelopmentEvidence(evidence):undefined;
 if(decision){
  const reconciled=decision.reconciliations;gaps=gaps.filter(g=>!reconciled.some(r=>r.includes(`「${g.replace(/^类目关键词洞察：/,'')}」`)));
  sections.pop();
  sections.push({title:'综合判断',status:'candidate',text:decision.candidates.length?`已形成 ${decision.candidates.filter(c=>c.status==='supported').length} 个具备关联证据的验证方向、${decision.candidates.filter(c=>c.status==='hold').length} 个需先核实风险的方向、${decision.candidates.filter(c=>c.status==='needs-evidence').length} 个待补关联方向。先按各方向的支持与反证验证方案；尚未证明商业空位和盈利。`:'尚未取得可关联的需求分类，保留各模块已有分析；不能据此指定产品方向。',refs:[]});
  actions.splice(0,actions.length,...decision.candidates.map(c=>({priority:c.status==='hold'?'P0' as const:'P1' as const,action:`${c.label}：${c.status==='hold'?'先核实反证与风险':'验证候选方案'}`,validation:c.next,refs:c.evidence.map(e=>e.ref).slice(0,300)})),{priority:'P0',action:'核算全成本并验证实际竞争与合规',validation:'不以来源毛利标签替代采购、履约、广告与退货成本；风险词提示需逐条核实。',refs:[]});
 }
 if(decision?.conflicts.some(c=>c.kind==='conflict'))actions.unshift({priority:'P0',action:'核对同口径冲突的来源版本',validation:'暂不据冲突指标判断机会或排序；逐项确认时间窗、样本及来源数值后再作开发决策。',refs:decision.conflicts.filter(c=>c.kind==='conflict').flatMap(c=>c.refs).slice(0,300)});
 const headline=decision?decision.conflicts.some(c=>c.kind==='conflict')?'存在同口径数据冲突，需核对后再作开发判断':decision.risks.length||decision.candidates.some(c=>c.status==='hold')?'存在需先核实的反证或风险；分方向决定是否继续':decision.candidates.some(c=>c.status==='supported')?'已建立需求—商品—评论证据链，可进入方案验证':'关联证据尚不完整，保留已知分析并继续验证':!known?'证据尚未就绪':'评论驱动的类目开发候选与验证计划';
 return DevelopmentConclusionSchema.parse({version:'market-development/20261015.2',...(decision?{decision}:{}),kind,scope,status:!known?'no-data':evidence.every(e=>e.status==='ready')?'evidence-ready':'partial',headline,evidence,sections,actions,gaps:[...new Set(gaps)].slice(0,220)});
}
