export const SORFTIME_QUOTA_MESSAGE='Sorftime 暂无额度，请联系管理员';
export type QuotaStep={current:boolean;status:string;kind?:string;errorCode:string|null;industryDemand?:boolean;externalStage?:string;sourceProvider?:'sorftime'};
const sorftimeKinds=new Set(['collect-shape-pool','collect-product-history','collect-product-amount-history','collect-product-image','collect-shape-category','collect-keyword-page','collect-keyword-trend','collect-customer-themes']);
/** Classify only confirmed current source failures; absence, timeouts and model failures are not quota evidence. */
export function marketSourceQuotaNotice(steps:readonly QuotaStep[]){
 const failed=steps.filter(s=>s.current&&s.status==='failed'&&s.errorCode==='quota-exhausted');
 if(!failed.length)return null;
 const sorftime=failed.some(s=>s.sourceProvider==='sorftime'||sorftimeKinds.has(s.kind??'')||s.kind==='collect-overview-month'&&['sales','prices'].includes(s.externalStage??''));
 return `${sorftime?SORFTIME_QUOTA_MESSAGE:'数据源暂无额度，请联系管理员'}。本次部分数据待补；已保存的数据和分析结果仍可查看。`;
}
