import type {SellerSpriteMarketNiche as Niche,SellerSpriteMarketReport as Report,SellerSpriteDistRow as Row} from './original-overview/sellersprite-market-niche';
import type {MarketOverviewOriginalSynthesis} from '../../../shared/market-overview-original-synthesis';
import type {OverviewInputIssues} from './overview-score-readiness';
type Chapter=NonNullable<MarketOverviewOriginalSynthesis['chapters']>[number];
const nonnegative=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const percent=(v:unknown):v is number=>nonnegative(v)&&v<=100;
export const completeSalesShares=(rows:readonly Pick<Row,'unitsShare'>[])=>rows.length>0&&rows.every(r=>percent(r.unitsShare))&&rows.reduce((n,r)=>n+r.unitsShare!,0)<=100.5;
const distributions={
 'seller-type':'sellerTypes','seller-country':'countries','listing-age':'listingAge','listing-trend':'listingTrend','rating-count':'ratingCounts','rating-value':'ratingValues','price':'prices',
} as const;
/** Read-only evidence gate shared by every category. Row presence is not field coverage. */
export function auditOverviewChapters(chapters:Chapter[],report:Report,niche:Niche,headTopN:number,issues:OverviewInputIssues):Chapter[]{
 return chapters.map(chapter=>{
  const missing=[...chapter.missing];let blockConclusion=false;
  const rankKey=({'product-crn':'products','brand-crn':'brands','seller-crn':'sellers'} as const)[chapter.id as 'product-crn'];
  if(rankKey){
   const rows=report[rankKey];
   if(!completeSalesShares(rows)){missing.push('排名销量份额缺失、无效或合计超过100%，无法确认完整排序');blockConclusion=true;}
   if(rows.length<3){missing.push('有效排名不足3条，不能计算完整Top3');blockConclusion=true;}
   if(rows.length<headTopN)missing.push(`返回排名不足请求Top${headTopN}，仅保留实际返回样本`);
  }
  const distKey=distributions[chapter.id as keyof typeof distributions];
  if(distKey){
   const rows=report[distKey];
   if(!completeSalesShares(rows)){missing.push('分组销量份额缺失、无效或合计超过100%，不能以商品占比替代');blockConclusion=true;}
   if(!rows.length||rows.some(r=>!nonnegative(r.products))){missing.push('分组商品数量缺失或无效');if(['seller-type','seller-country','price'].includes(chapter.id))blockConclusion=true;}
   const sourceIssues=issues[distKey as keyof OverviewInputIssues];if(sourceIssues?.length){missing.push(...sourceIssues);blockConclusion=true;}
   if(chapter.id==='price'&&!rows.some(r=>r.items?.some(p=>nonnegative(p.profit))))missing.push('价格带商品毛利率缺失，利润与准入结论待验证');
   if(chapter.id==='listing-age'&&!nonnegative(niche.newRatio)){missing.push('新品占比缺失，不能联合判断成熟度');blockConclusion=true;}
   if(chapter.id==='listing-trend'&&!nonnegative(niche.newRatio)){missing.push('新品占比缺失，不能联合判断新增供给');blockConclusion=true;}
  }
  if(chapter.id==='overview'){
   for(const [key,label] of [['productCrn','商品集中度'],['brandCrn','品牌集中度'],['sellerCrn','卖家集中度'],['newRatio','新品占比'],['avgUnits','平均销量'],['newAvgUnits','新品平均销量']] as const)if(!nonnegative(niche[key]))missing.push(`${label}缺失`);
   if(!report.keywordTrends.some(r=>r.points.length>=6))missing.push('搜索趋势有效窗口不足');
   if(report.salesTrend.length<6)missing.push('行业销量趋势有效窗口不足');
  }
  if(blockConclusion)missing.push('本章仅保留已知事实，完整比较与开发判断待补齐证据');
  return {...chapter,missing:[...new Set(missing)].slice(0,20),status:chapter.status==='insufficient'?'insufficient':missing.length?'partial':'ready',
   ...(blockConclusion?{conclusion:'已保留本次返回的有效数据；关键份额、分母或覆盖范围不足，暂不形成完整比较和开发判断。'}:{})};
 });
}
