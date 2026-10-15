import type { SorftimeCategoryDashboardReport, SorftimeCategoryDashboardProduct } from '../types';
import { hasReferencePeriodDateConflict, parseReferenceListingDate, referencePeriodContribution, resolveProductPriceBand, resolveReferenceProductShape } from '../rules';
import { buildMarketStructureSynthesis, type MarketStructureSynthesisResult, type MarketStructureModuleSection } from './market-structure-synthesis-analysis';

type Key = MarketStructureModuleSection['key'];
type Gap = {asin:string;fields:string[]};
export type SynthesisSection = Omit<MarketStructureModuleSection,'score'> & {
  score:number|null;
  coverage?:{known:number;total:number;sales:number|null};
  gaps?:Gap[];
  notes?:string[];
};
export type SynthesisPresentation = Omit<MarketStructureSynthesisResult,'score'|'moduleSections'|'highlights'> & {
  score:number|null;
  moduleSections:SynthesisSection[];
  highlights:Omit<MarketStructureSynthesisResult['highlights'],'marginGreenSharePct'> & {marginGreenSharePct:number|null};
  highlightNotes?:string;
};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const dimensions:ReadonlyArray<{key:Key;title:string;fields:readonly string[]}>= [
  {key:'newProductEntry',title:'新品准入机会',fields:['销量','日期']},
  {key:'shapePriceDistribution',title:'价格带分布 · 形态分化',fields:['销量','价格','形态']},
  {key:'marginMarketAccess',title:'市场准入 · 形态×价格带',fields:['销量','价格','毛利']},
  {key:'productShapeDirection',title:'商品形态方向切入',fields:['销量','价格','毛利','形态']},
  {key:'layoutLearning',title:'品牌 · 商品形态 · 价格带布局方向',fields:['销量','价格','品牌','形态']},
];

/** Replay each original dimension only with its own valid inputs. Never sum differing scopes. */
export function buildReferenceSynthesisPresentation(report:SorftimeCategoryDashboardReport, assignments:Readonly<Record<string,string>>, selectedAsins?:readonly string[], allowedShapes?:readonly string[]):SynthesisPresentation {
  const selected=selectedAsins?new Set(selectedAsins):null;
  const products=report.products.filter(p=>!selected||selected.has(p.asin)).map(p=>({...p,priceBand:resolveProductPriceBand(p),sales:{...p.sales,
    y2024:referencePeriodContribution(p,'y2024',report.calculationVersion),y2025:referencePeriodContribution(p,'y2025',report.calculationVersion),
  }}));
  const byAsin=new Map(products.map(p=>[p.asin,p]));
  const shape=(asin:string)=>{
    const p=byAsin.get(asin);
    const value=p?resolveReferenceProductShape(p,assignments):'—';
    return !value||value==='未分类'||value==='—'||(allowedShapes?.length&&!allowedShapes.includes(value))?'—':value;
  };
  const missing=(p:SorftimeCategoryDashboardProduct,fields:readonly string[])=>{
    const gaps:string[]=[];
    if(fields.includes('销量')&&(!finite(p.sales.last6Months)||p.sales.last6Months<0))gaps.push('近6个月销量');
    if(fields.includes('销量')&&hasReferencePeriodDateConflict(p,'last6Months',report.calculationVersion))gaps.push('近6个月销量与上市日期冲突');
    if(fields.includes('日期')&&parseReferenceListingDate(p.onlineDate).status!=='known')gaps.push('上市日期');
    if(fields.includes('日期')&&!Number.isFinite(Date.parse(report.fetchedAt)))gaps.push('报告采集日期');
    if(fields.includes('价格')&&(!p.priceBand||p.priceBand==='—'))gaps.push('价格及价格带');
    if(fields.includes('毛利')&&!finite(p.grossProfitMargin))gaps.push('毛利润率');
    if(fields.includes('品牌')&&(!p.brand?.trim()||p.brand==='—'))gaps.push('品牌');
    if(fields.includes('形态')&&shape(p.asin)==='—')gaps.push('商品形态待标注');
    return gaps;
  };
  // The legacy type requires 30-day totals; synthesis only reads the validated six-month inputs. Preserve nullable source values.
  const replay=(pool:typeof products)=>buildMarketStructureSynthesis({...report,stats:{...report.stats,top3ProductSharePct:pool.length===report.products.length?report.stats.top3ProductSharePct:null},products:pool,topLinkCount:pool.length} as Parameters<typeof buildMarketStructureSynthesis>[0],{getProductShape:shape});
  const moduleSections:SynthesisSection[]=dimensions.map(d=>{
    const gaps=products.map(p=>({asin:p.asin,fields:missing(p,d.fields)})).filter(g=>g.fields.length);
    const excluded=new Set(gaps.map(g=>g.asin));
    const pool=products.filter(p=>!excluded.has(p.asin));
    const sales=pool.length?pool.reduce((sum,p)=>sum+p.sales.last6Months!,0):null;
    const base={key:d.key,title:d.title,maxScore:20,coverage:{known:pool.length,total:products.length,sales},gaps};
    if(!pool.length||!sales)return {...base,score:null,text:pool.length?'有效样本近6个月销量合计为0，无法计算销量份额，暂不生成本维判断。':'本维缺少可计算样本；补齐下列字段后生成原版分析。'};
    const section=replay(pool).moduleSections.find(s=>s.key===d.key)!;
    const unclassified=d.key==='marginMarketAccess'?pool.filter(p=>shape(p.asin)==='—').length:0;
    return {...section,...base,score:gaps.length?null:section.score,notes:unclassified?[`${unclassified} 条有效毛利样本尚未标注形态；总体准入分析保留，形态价格带指导仅覆盖已标注部分。`]:[]};
  });
  const missingRecent=products.filter(p=>!finite(p.sales.last3Months)||p.sales.last3Months<0||hasReferencePeriodDateConflict(p,"last3Months",report.calculationVersion));
  const complete=products.length>0&&moduleSections.every(s=>s.score!==null)&&missingRecent.length===0;
  if(complete)return {...replay(products),moduleSections};

  const marginPool=products.filter(p=>finite(p.grossProfitMargin));
  const green=marginPool.filter(p=>p.grossProfitMargin!>=60).length;
  const bandPool=products.filter(p=>!missing(p,['销量','价格']).length);
  const bands=new Map<string,number>();
  for(const p of bandPool)bands.set(p.priceBand,(bands.get(p.priceBand)??0)+p.sales.last6Months!);
  const bandSales=bandPool.reduce((sum,p)=>sum+p.sales.last6Months!,0);
  const topBand=bandSales>0?[...bands].sort((a,b)=>b[1]-a[1])[0]?.[0]??null:null;
  const usable=moduleSections.filter(s=>(s.coverage?.sales??0)>0);
  const scopeNote=(s:SynthesisSection)=>`${s.title}（有效样本 ${s.coverage!.known}/${products.length}）`;
  const opportunities:string[]=[];
  const risks:string[]=[];
  if(missingRecent.length)risks.push(`跨维品牌趋势还缺 ${missingRecent.length} 条近3个月销量（${missingRecent.map(p=>p.asin).join("、")}）；保留各维近6月分析，完整跨维结论及总分暂缓。`);
  const margin=usable.find(s=>s.key==='marginMarketAccess')?.marginAccessDetail;
  if(margin)opportunities.push(`毛利准入有效样本中，优先/建议进入的销量占比 ${margin.favorableSalesPct.toFixed(1)}%，可进入空间 ${margin.accessibleSalesPct.toFixed(1)}%；结合本维形态×价格带指导及全成本核算筛选。`);
  const layout=usable.find(s=>s.key==='layoutLearning');
  if(layout)opportunities.push(`${scopeNote(layout)}：${layout.text}`);
  const direction=usable.find(s=>s.key==='productShapeDirection');
  if(direction)opportunities.push(`${scopeNote(direction)}：${direction.text}`);
  for(const section of moduleSections)if(section.score===null)risks.push(`${section.title}：${section.gaps?.length?`${section.gaps.length} 条商品缺本维必要字段`:'销量分母不足'}；本维不评分，不能将有效样本的占比推广为全部所选商品。`);
  if(finite(report.stats.returnRatePct)&&report.stats.returnRatePct>=8)risks.push(`来源类目退货率 ${report.stats.returnRatePct.toFixed(2)}%，需核算售后成本。`);
  return {
    version:'2.0.0',categoryName:report.categoryName,marketplace:report.marketplace,
    sampleScope:`${report.marketplace} · ${report.categoryName} · 所选${products.length}条`,topLinkCount:products.length,
    score:null,verdict:'数据不足',verdictColor:'gray',verdictDefinition:'各维度按有效证据独立分析；尚缺必要字段的维度单独标注，总分暂不可计算。',
    summary:`所选 ${products.length} 条商品保留在报告中，五个维度中 ${usable.length} 个可展示原版分析。各维度的有效样本和缺口见下方，不合并不同样本范围的分数。`,
    finalVerdict:'最终进入判断待必要数据补齐；下方原版分析仅对应各自标明的有效样本，供继续核实机会与风险。',
    crossSignals:[],moduleSections,opportunities:opportunities.length?opportunities:['当前没有足够证据形成机会方向；补齐对应维度的数据后再判断。'],risks,
    recommendedActions:['按各维缺口定向补齐历史销量和属性，保留已有数据；完成形态标注后再核对完整评分。'],confidence:'insufficient',
    highlights:{primaryPriceBand:topBand,primaryBrandPriceBand:null,listingAgeType:'待补数据',marginGreenSharePct:marginPool.length?green/marginPool.length*100:null,
      top3ListingSharePct:products.length===report.products.length?report.stats.top3ProductSharePct:null,hardToEnterBands:[]},
    highlightNotes:`主销价格带按 ${bandPool.length}/${products.length} 条价格与销量有效样本计算；毛利链接占比按 ${marginPool.length}/${products.length} 条毛利有效样本计算。TOP3为来源报告指标，缩小所选范围时不沿用。`,
  };
}
