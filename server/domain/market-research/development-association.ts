import type {ConclusionEvidence} from '../../../shared/market-development-conclusion';
import type {DevelopmentDecision,DevelopmentObservations} from '../../../shared/market-development-association';

// Explicit lexical bridges, not semantic similarity or causal attribution. No category identifiers.
const bridges:[string,RegExp][]=[
 ['folding',/折叠|fold(?:able|ing|ability)?|klappbar|faltbar|折りたたみ/iu],
 ['portable',/便携|portable|portability|携帯/iu],['waterproof',/防水|waterproof|wasserdicht|防水性/iu],
 ['dimmable',/调光|dimm(?:able|ing)|調光/iu],['children',/儿童|小孩|\bkids?\b|\bchildren\b|\bchild\b|kinder|子供/iu],
 ['adult',/成人|\badults?\b|erwachsene|大人/iu],['durability',/耐用|耐久|durab(?:le|ility)|haltbarkeit/iu],
 ['lightweight',/轻量|轻便|lightweight|軽量/iu],['brightness',/亮度|brightness|helligkeit|明るさ/iu],
];
const normalized=(s:string)=>s.normalize('NFKC').toLocaleLowerCase().trim();
function concepts(s:string){return bridges.filter(([,r])=>r.test(s)).map(([id])=>id);}
function matches(label:string,value:string){
 const ids=concepts(label);if(ids.length){const check=(id:string)=>bridges.find(b=>b[0]===id)![1].test(value);return /[/、或]/.test(label)?ids.some(check):ids.every(check);}
 const needle=normalized(label),hay=normalized(value);if(!needle||needle.length<2||/^(规格|其他|通用|功能|属性|unknown|other|general)$/i.test(needle))return false;
 return /[\u3400-\u9fff\u3040-\u30ff]/.test(needle)?hay.includes(needle):new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}($|[^\\p{L}\\p{N}])`,'iu').test(hay);
}
function opposed(label:string,value:string){
 const ids=concepts(label),patterns=ids.length?ids.map(id=>bridges.find(b=>b[0]===id)![1].source):[normalized(label).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')];
 // Negation must modify this attribute. "Non-slip deck" is not counterevidence to folding or kids.
 return patterns.some(pattern=>new RegExp(`(?:\\bnot\\s+(?:suitable\\s+)?(?:for\\s+)?|\\bnon[- ]|\\bwithout\\s+|不可|不支持|不具备|非|不)(?:${pattern})`,'iu').test(value));
}
const risky=(s:string)=>/\binjur(?:y|ies)|\bchok(?:e|ing)|\bfire\b|\bburn(?:s|ed)?\b|\belectric shock\b|窒息|起火|触电|受伤|割伤|火傷|けが/iu.test(s)&&!/(?:no|without|never|not)\s+(?:\w+\s+){0,2}(?:injury|choking|fire|burns)|没有受伤|无起火|未受伤/iu.test(s);
export const ASSOCIATION_RULES=[
 {id:'LINK-01',version:'1',condition:'同站点、类目和研究窗口内，以明确同义词或完整标签匹配需求与产品；评论必须连接相同ASIN。',limitation:'文本匹配不是搜索购买归因，不证明需求规模、因果关系或供给空白；未覆盖语言/词义保持待验证。'},
 {id:'PRICE-01',version:'1',condition:'只汇总候选关联ASIN中已知同币种价格，并展示覆盖数与来源窗口。',limitation:'不是建议售价、历史月价格或利润；缺价不补零，不跨币种合并。'},
 {id:'RISK-01',version:'1',condition:'扫描全部已保存评论片段；负向计数且出现严重风险词时进入人工风险审查。',limitation:'主题负向计数并非片段独立计数；词表可能漏检或误报，不作安全认证或自动认定缺陷。'},
 {id:'BASIS-01',version:'1',condition:'同指标、单位、实际窗口、分母和样本身份一致才比较数值；值不同则保留冲突。',limitation:'不同口径单列解释，不平均或择优取值；来源未知时不能宣称已解决冲突。'},
 {id:'DECISION-01',version:'1',condition:'需求词、对应商品和同ASIN评论有可追溯文本关联时形成候选；相反属性或关联严重风险暂缓该方向。',limitation:'候选不等于批准立项；成本、竞争空位与合规需另证，缺口仅阻断依赖它的判断。'},
];
type Review=NonNullable<DevelopmentObservations['reviews']>[number];
export function associateDevelopmentEvidence(input:ConclusionEvidence[]):DevelopmentDecision{
 const usable=input.filter(e=>(e.status==='ready'||e.status==='partial')&&e.scope!==null&&e.identity!==null);
 const demands=usable.filter(e=>e.module==='keywords').flatMap(e=>e.observations?.demands??[]);
 const products=usable.filter(e=>e.module==='shapes').flatMap(e=>e.observations?.products??[]);
 const reviews=usable.filter(e=>e.module==='themes').flatMap(e=>e.observations?.reviews??[]);
 const marketContext=usable.filter(e=>e.module==='overview').flatMap(e=>(e.observations?.metrics??[]).map(m=>({module:'overview',ref:m.ref,description:`${m.label}：${m.value} ${m.unit}；${m.period}；${m.denominator}。仅用于该来源样本的市场背景，不代表候选销量或全市场。`})));
 const metrics=usable.flatMap(e=>e.observations?.metrics??[]);
 const risks=reviews.filter(r=>r.negative>0&&risky(`${r.topic} ${r.text}`)).map(r=>({asin:r.asin,ref:r.ref,text:r.text,reason:'出现严重风险词且该主题有负向提及；优先核对原摘要和样品，尚未认定产品缺陷。'}));
 const conflicts:DevelopmentDecision['conflicts']=[];
 for(let i=0;i<metrics.length;i++)for(let j=i+1;j<metrics.length;j++){
  const a=metrics[i],b=metrics[j];if(a.key!==b.key||a.ref===b.ref)continue;
  const same=![a.unit,a.period,a.denominator,a.sample,b.unit,b.period,b.denominator,b.sample].some(v=>!v||/未知|未确认|未提供|unknown/i.test(v))&&a.unit===b.unit&&a.period===b.period&&a.denominator===b.denominator&&a.sample===b.sample;
  if(same&&a.value===b.value)continue;
  conflicts.push({kind:same?'conflict':'basis',message:`${a.label} ${a.value}${a.unit}（${a.period}；分母/范围：${a.denominator}；样本：${a.sample}）与 ${b.label} ${b.value}${b.unit}（${b.period}；分母/范围：${b.denominator}；样本：${b.sample}）${same?'同口径数值冲突，未选择或平均任一来源。':'口径不同，不能直接比较；分别保留。'}`,refs:[a.ref,b.ref]});
 }
 const seen=new Set<string>();
 const candidates:DevelopmentDecision['candidates']=[];
 for(const d of demands){
  const key=d.dimension+':'+(concepts(d.label).join('+')||normalized(d.label));if(seen.has(key)||!d.keywords.length)continue;seen.add(key);
  const matched=products.filter(p=>matches(d.label,`${p.shape??''} ${p.title}`));
  const opposing=matched.filter(p=>opposed(d.label,`${p.shape??''} ${p.title}`));
  const supports=matched.filter(p=>!opposing.includes(p));
  const joined=reviews.filter(r=>supports.some(p=>p.asin===r.asin)&&matches(d.label,`${r.topic} ${r.text}`));
  const candidateRisks=risks.filter(r=>matched.some(p=>p.asin===r.asin));
  const counter=[...opposing.map(p=>`${p.asin} 标题/标签含相反属性：${p.title}`),...joined.filter(r=>r.negative>0).map(r=>`${r.asin}「${r.topic}」主题负向/分歧 ${r.negative} 次；非该属性的独立差评数。摘要：${r.text}`),...candidateRisks.map(r=>`${r.asin} 风险待核实：${r.text}`)];
  const currencies=[...new Set(supports.filter(p=>p.price!==null&&p.currency).map(p=>p.currency!))];
  const price=currencies.map(c=>{const rows=supports.filter(p=>p.currency===c&&p.price!==null);return `${c} ${Math.min(...rows.map(p=>p.price!))}–${Math.max(...rows.map(p=>p.price!))}（${rows.length}/${supports.length}条；${[...new Set(rows.map(p=>p.period))].join('、')}）`;}).join('；')||'尚无可核对的同币种价格';
  const missing=[...(!supports.length?['缺少对应属性的商品标题/已保存形态证据']:[]),...(!joined.length?['缺少同一ASIN且与该需求相关的评论文本']:[]),...(supports.some(p=>p.price===null||!p.currency)||!currencies.length?['关联商品价格或币种不完整']:[]),'搜索词与商品的实际点击/购买关系未取得，当前为文本关联','是否为未满足需求仍需对照竞品功能覆盖与问题机制','完整成本、利润及合规证据待验证'];
  const status=opposing.length||candidateRisks.length?'hold':supports.length&&joined.length?'supported':'needs-evidence';
  const reviewEvidence=(r:Review)=>({module:'themes',ref:r.ref,description:`${r.asin} · ${r.topic} · 来源更新${r.period} · ${r.text}（主题正向${r.positive}、负向${r.negative}；不是逐条评论数）`});
  candidates.push({id:key,label:d.label,dimension:d.dimension,status,reason:status==='hold'?'存在相反属性或关联风险；先核实，不建议据此直接定型。':status==='supported'?'需求词、商品属性与同ASIN评论已形成可复核的文本证据链，可进入方案验证。':'已有需求线索；产品或同ASIN评论关联尚未完整，保留已知依据。',keywords:d.keywords,asins:supports.map(p=>p.asin),price,
   evidence:[...marketContext,{module:'keywords',ref:d.ref,description:`需求标签：${d.label}；关键词：${d.keywords.join('、')}；来源搜索量${d.volume??'未知'}（${d.period}，不视为转化或独立买家）`},...matched.map(p=>({module:'shapes',ref:p.ref,description:`${p.asin} · ${p.title} · 保存形态：${p.shape??'未标注'} · ${p.currency??'币种未知'} ${p.price??'价格未知'} · ${p.period}`})),...joined.map(reviewEvidence)],counterevidence:counter,missing,
   next:status==='hold'?`先核对「${d.label}」相关相反属性/风险的原文与ASIN，再决定是否继续该方案。`:`针对「${d.label}」的关联ASIN复核功能与评论，定义可测量的样品验收指标；补成本后再决定定价和试单。`});
 }
 const reconciliations:string[]=[];
 for(const e of usable)for(const gap of e.gaps){
  if(e.module!=='keywords')continue;
  if(/缺少.*(评论|VOC|差评)/i.test(gap)&&reviews.length)reconciliations.push(`关键词模块原缺口「${gap}」：本批评论已提供${reviews.length}个来源片段；${candidates.some(c=>c.evidence.some(e=>e.module==='themes'))?'部分需求已关联同ASIN评论，详见候选证据；':'尚未建立对应需求关联；'}购买动机/未满足需求仍须逐项验证。`);
  if(/缺少.*(价格分布|商品价格)/.test(gap)&&products.some(p=>p.price!==null&&p.currency))reconciliations.push(`关键词模块原缺口「${gap}」：本批已保存商品价格，候选按关联ASIN展示覆盖及实际窗口；不据此补算利润或历史售价。`);
 }
 candidates.sort((a,b)=>({supported:0,hold:1,'needs-evidence':2}[a.status]-{supported:0,hold:1,'needs-evidence':2}[b.status])||a.id.localeCompare(b.id));
 return {marketContext,rules:ASSOCIATION_RULES,candidates,conflicts,risks,reconciliations,coverage:`核对${demands.length}组需求、${products.length}个所选商品、${reviews.length}个已保存评论片段；形成${candidates.length}个方向，全部保留。实际搜索/购买归因未知；报告月份不等于所有来源的观测月份。`};
}
