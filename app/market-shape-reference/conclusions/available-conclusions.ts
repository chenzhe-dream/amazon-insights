import { buildReferenceConclusions, type ReferenceConclusions } from './index';
import type { SorftimeCategoryDashboardReport } from '../types';
import { hasReferencePeriodDateConflict, referencePeriodContribution, resolveReferenceProductShape, resolveProductPriceBand, parseReferenceListingDate } from '../rules';

/** Section summaries expose their valid sample explicitly; source tables keep all selected products. */
export function buildAvailableReferenceConclusions(report:SorftimeCategoryDashboardReport,assignments:Readonly<Record<string,string>>,selectedAsins?:readonly string[],allowedShapes?:readonly string[]):ReferenceConclusions {
  const result=buildReferenceConclusions(report,assignments,selectedAsins,allowedShapes);
  const selected=selectedAsins?new Set(selectedAsins):null;
  const all=report.products.filter(p=>!selected||selected.has(p.asin));
  const isKnown=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const keys=['margin','listingYear','shapeSales','shapePrice','brandPrice'] as const;
  for(const key of keys){
    const needsShape=key==='shapeSales'||key==='shapePrice';
    const periods=key==='shapeSales'?['last3Months','last6Months','y2024'] as const:key==='shapePrice'||key==='brandPrice'?['last3Months','last6Months'] as const:['last6Months'] as const;
    const pool=all.filter(p=>{
      if(periods.some(period=>!isKnown(referencePeriodContribution(p,period,report.calculationVersion))||hasReferencePeriodDateConflict(p,period,report.calculationVersion)))return false;
      if(key==='listingYear'&&parseReferenceListingDate(p.onlineDate).status!=='known')return false;
      if(key==='margin'&&(typeof p.grossProfitMargin!=='number'||!Number.isFinite(p.grossProfitMargin)))return false;
      if(['margin','shapePrice','brandPrice'].includes(key)&&resolveProductPriceBand(p)==='—')return false;
      if(key==='brandPrice'&&(!p.brand?.trim()||p.brand==='—'))return false;
      const shape=resolveReferenceProductShape(p,assignments);
      return !needsShape||(shape!=='—'&&shape!=='未分类'&&(!allowedShapes?.length||allowedShapes.includes(shape)));
    });
    if(pool.length===all.length)continue;
    if(!pool.length){if(result[key].status!=='insufficient')result[key]={status:'insufficient',reason:'当前范围没有满足本项必要字段的有效样本（销量、形态等），缺失数据保留未知。'};continue;}
    const slot=buildReferenceConclusions(report,assignments,pool.map(p=>p.asin),allowedShapes)[key];
    const included=new Set(pool.map(p=>p.asin));
    const scoped=slot.status==='ready'?{...slot,scope:{included:pool.length,total:all.length,excludedAsins:all.filter(p=>!included.has(p.asin)).map(p=>p.asin)}}:slot;
    // The key and result were obtained together from the same typed builder.
    Object.assign(result,{[key]:scoped});
  }
  return result;
}
