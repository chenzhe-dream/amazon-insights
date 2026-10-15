import {DevelopmentObservationsSchema,type DevelopmentObservations} from '../../../shared/market-development-association';
type Row=Record<string,unknown>;
const obj=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const list=(v:unknown):Row[]=>Array.isArray(v)?v.map(obj):[];
const str=(v:unknown)=>typeof v==='string'?v:'';
const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
const strings=(v:unknown)=>Array.isArray(v)?v.filter((s):s is string=>typeof s==='string'):[];
/** Structural extraction from already validated saved reports; never mine generated summary prose. */
export function extractDevelopmentObservations(module:string,payload:unknown,identity:string):DevelopmentObservations{
 const p=obj(payload),out:DevelopmentObservations={};
 if(module==='keywords'){
  const dims=obj(obj(p.report).dimensions);
  out.demands=(['w2','w3','w4'] as const).flatMap(k=>list(obj(dims[k]).rows).map((r,i)=>({r,i})).filter(({r})=>str(r.label)&&strings(r.keywords).length).map(({r,i})=>({label:str(r.label),dimension:({w2:'audience',w3:'scenario',w4:'feature'} as const)[k],keywords:strings(r.keywords),volume:(num(r.monthlySearches)??-1)>=0?num(r.monthlySearches):null,period:'来源页月搜索量，具体统计月份未确认',ref:`${identity}#report.dimensions.${k}.rows[${i}]`}))) ;
 }
 if(module==='themes'){
  const result=obj(p.result),selected=new Set(strings(result.selectedAsins));
  out.reviews=list(result.evidence).flatMap(g=>list(g.members)).filter(m=>selected.has(str(m.asin))&&str(m.sourceThemeId)&&str(obj(m.content).text)).map(m=>({asin:str(m.asin),topic:str(obj(m.keyword).text),text:str(obj(m.content).text)+(obj(m.content).truncated?'【保存片段已截断，需核对完整来源】':''),positive:Math.max(0,num(m.positive)??0),negative:Math.max(0,num(m.negative)??0),period:str(m.sourceUpdatedAt)||'摘要统计窗口未提供',ref:str(m.sourceThemeId)}));
 }
 if(module==='shapes'){
  const data=obj(p.data),pool=obj(data.pool),scope=obj(data.scope),assignments=obj(p.assignments),selected=Array.isArray(p.selectedAsins)?new Set(strings(p.selectedAsins)):null;
  const products=list(pool.products).filter(r=>str(r.asin)&&(!selected||selected.has(str(r.asin))));
  out.products=products.map(r=>({asin:str(r.asin),title:str(r.title),shape:str(assignments[str(r.asin)])||null,price:(num(r.price)??0)>0?num(r.price):null,currency:str(scope.currency)||null,period:`采集时价格 ${str(pool.fetchedAt)||'时间未知'}（非研究月历史价格）`,ref:`${identity}#products/${str(r.asin)}`}));
  out.metrics=[{key:'sample-products',label:'形态所选商品数',value:products.length,unit:'count',period:str(pool.fetchedAt)||'抓取时间未知',denominator:'所选商品',sample:identity,ref:`${identity}#selectedAsins`}];
  const end=str(scope.toMonth),monthIndex=(s:string)=>{const m=/^(\d{4})-(\d{2})/.exec(s);return m?Number(m[1])*12+Number(m[2])-1:NaN;};
  const histories=list(obj(data.productHistory).products),cutoff=monthIndex(end)-5;
  const eligible=products.flatMap(r=>{
   const date=monthIndex(str(r.listedAt)),points=list(histories.find(h=>h.asin===r.asin)?.points).filter(q=>monthIndex(str(q.month))>=cutoff&&monthIndex(str(q.month))<=monthIndex(end));
   // Do not infer zero for missing months or unknown listing dates.
   if(!Number.isFinite(date)||date>monthIndex(end)||points.length!==6||new Set(points.map(q=>q.month)).size!==6||points.some(q=>num(q.units)===null||Number(q.units)<0))return [];
   return [{asin:str(r.asin),isNew:date>=cutoff,sales:points.reduce((sum,q)=>sum+Number(q.units),0)}];
  });
  const total=eligible.reduce((s,r)=>s+r.sales,0);
  if(total>0)out.metrics.push({key:'new-share',label:'新品历史销量占比（完整六个日历月子样本）',value:Math.round(eligible.filter(r=>r.isNew).reduce((s,r)=>s+r.sales,0)/total*10000)/100,unit:'%',period:`截至${end}的六个日历月；新品按该六个月上架判定`,denominator:`完整销量且已知上架日${eligible.length}/${products.length}条，总销量${total}`,sample:eligible.map(r=>r.asin).sort().join(','),ref:`${identity}#productHistory/new-share`});
 }
 if(module==='overview'){
  out.metrics=[];
  for(const row of list(obj(p.numbers).months)){
   const metrics=obj(row.metrics),known=(k:string)=>obj(metrics[k]).state==='known'?num(obj(metrics[k]).value):null;
   const count=known('sampleProducts'),newCount=known('newCount');
   if(count!==null)out.metrics.push({key:'sample-products',label:'总览样本商品数',value:count,unit:'count',period:str(row.month),denominator:'总览返回样本',sample:identity,ref:`${identity}#numbers.months/${str(row.month)}/sampleProducts`});
   if(count!==null&&count>0&&newCount!==null)out.metrics.push({key:'new-share',label:'新品链接占比（来源新品定义）',value:Math.round(newCount/count*10000)/100,unit:'%',period:str(row.month),denominator:`链接数 ${newCount}/${count}，不是销量`,sample:identity,ref:`${identity}#numbers.months/${str(row.month)}/newCount`});
   for(const key of ['totalUnits','avgPrice','avgRating']){const value=known(key);if(value===null)continue;const unit=obj(obj(metrics[key]).unit);out.metrics.push({key,label:({totalUnits:'样本销量',avgPrice:'样本均价',avgRating:'样本平均评分'})[key]!,value,unit:str(unit.currency)||str(unit.unit)||'单位未知',period:str(row.month),denominator:'总览返回样本',sample:identity,ref:`${identity}#numbers.months/${str(row.month)}/${key}`});}
  }
 }
 return DevelopmentObservationsSchema.parse(out);
}
