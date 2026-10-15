import type { SorftimeCategoryDashboardReport } from '../types';
import { parseReferenceListingDate, referencePeriodContribution, hasReferencePeriodDateConflict, resolveProductPriceBand, resolveReferenceProductShape, resolveSorftimeMarginEntryLabel } from '../rules';

const periods = {last3Months:'近3个月销量', last6Months:'近6个月销量', y2024:'2024销量', y2025:'2025销量'} as const;
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A factual projection of every selected product, never an imputed or rescored report. */
export function buildReferenceEvidenceSummary(report: SorftimeCategoryDashboardReport, assignments: Readonly<Record<string,string>>, selectedAsins?: readonly string[], allowedShapes?: readonly string[]) {
  const selected = selectedAsins ? new Set(selectedAsins) : null;
  const products = report.products.filter(p => !selected || selected.has(p.asin));
  const gaps: Array<{asin:string;fields:string[]}> = [];
  const groups = {shape:new Map<string,number>(), price:new Map<string,number>(), brand:new Map<string,number>(), margin:new Map<string,number>()};
  let sixMonthKnown=0, sixMonthSales=0, knownDates=0, classified=0;
  for (const p of products) {
    const fields:string[]=[];
    for (const [period,label] of Object.entries(periods)) {
      const key=period as keyof typeof periods;
      if(hasReferencePeriodDateConflict(p,key,report.calculationVersion)) fields.push(`${label}与上市日期冲突`);
      else if(!valid(referencePeriodContribution(p,key,report.calculationVersion))) fields.push(label);
    }
    if(valid(p.sales.last6Months) && !hasReferencePeriodDateConflict(p,'last6Months',report.calculationVersion)) {sixMonthKnown++;sixMonthSales+=p.sales.last6Months;}
    if(parseReferenceListingDate(p.onlineDate).status==='known') knownDates++; else fields.push('上市日期');
    const resolved=resolveReferenceProductShape(p,assignments);
    const shape=allowedShapes?.length && !allowedShapes.includes(resolved) ? '未分类' : resolved;
    if(shape && shape!=='未分类' && shape!=='—') classified++; else fields.push('商品形态待标注');
    const price=resolveProductPriceBand(p);
    if(!price || price==='—') fields.push('价格及价格带');
    if(typeof p.grossProfitMargin!=='number'||!Number.isFinite(p.grossProfitMargin)) fields.push('毛利润率');
    for(const [key,label] of [['shape',shape||'未分类'],['price',price||'未知'],['brand',p.brand?.trim()||'未知'],['margin',resolveSorftimeMarginEntryLabel(p.grossProfitMargin).label.replace("—","未知")]] as const) groups[key].set(label,(groups[key].get(label)??0)+1);
    if(fields.length) gaps.push({asin:p.asin,fields});
  }
  const leaders=(group:Map<string,number>, limit=3)=>[...group].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit).map(([name,count])=>`${name} ${count} 条`).join('、')||'暂无样本';
  return {total:products.length,sixMonthKnown,sixMonthSales:sixMonthKnown?sixMonthSales:null,knownDates,classified,gaps,
    sections:[
      {title:'历史销量与新品准入',text:`近6个月销量可计算 ${sixMonthKnown}/${products.length} 条，上市日期明确 ${knownDates}/${products.length} 条。缺失数据补齐前不推断新品机会或完整销量份额。`},
      {title:'商品形态方向',text:`已标注形态 ${classified}/${products.length} 条。按链接数分布：${leaders(groups.shape)}。未分类商品仍保留在所选范围内。`},
      {title:'价格带布局',text:`按链接数分布：${leaders(groups.price)}。此处反映链接布局，不代表销售需求或主销价格带。`},
      {title:'品牌布局',text:`按链接数分布：${leaders(groups.brand)}。销量不完整时，不据此判定品牌垄断或市场份额。`},
      {title:'毛利准入',text:`平台费后毛利标签：${leaders(groups.margin,5)}。采购、头程和广告成本仍需另行核算。`},
    ]};
}
export type ReferenceEvidenceSummary=ReturnType<typeof buildReferenceEvidenceSummary>;
