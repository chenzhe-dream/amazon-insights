import type {MarketShapeRun} from '../shared/market-shape-public-contracts';
import {shapeNumber} from './market-shape-dashboard';
type History=NonNullable<NonNullable<MarketShapeRun['source']>['productHistory']>['products'][number];
const statuses:Record<History['status'],string>={queued:'历史待采集',running:'历史采集中',ready:'历史已保存',partial:'部分月份无效',empty:'来源无历史',failed:'历史采集失败，可在任务详情重试',cancelled:'历史采集已取消'};
export function MarketShapeHistoryMonths({history}:{history:History}){
 return <div aria-label={`${history.asin} 月度销量`} style={{maxHeight:84,overflowY:'auto'}}>
  <small title="Sorftime product_trend SalesVolume；独立历史，不与参考月销量原值拼接">Sorftime 月销量</small>
  {history.points.length?history.points.map(point=><p key={point.month} title={point.issues.length?'该月数据无效，未计入周期汇总':undefined} style={{margin:0,whiteSpace:'nowrap'}}>{point.month}：{shapeNumber(point.units)}</p>):<p style={{margin:0}}>{statuses[history.status]}</p>}
 </div>;
}
export function MarketShapeHistoryPeriod({history,id}:{history:History;id:string}){
 const period=history.periods.find(p=>p.id===id);
 const ready=['ready','partial'].includes(history.status);
 return <td title={period?`Sorftime ${period.fromMonth} 至 ${period.toMonth}；${period.missingMonths.length?`缺少有效月份：${period.missingMonths.join('、')}`:'完整日历区间合计'}`:'历史尚未取得'}>
  {!ready?statuses[history.status]:period?.units==null?'缺少完整月份':shapeNumber(period.units)}
 </td>;
}
