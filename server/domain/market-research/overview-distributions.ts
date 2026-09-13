import {MarketOverviewDistributionOperationSchema,MarketOverviewDistributionSchema,MARKET_OVERVIEW_DISTRIBUTION_VERSION,type MarketOverviewDistribution,type MarketOverviewDistributionOperation} from '../../../shared/market-overview-distribution-contracts';
import {MarketInputRecordSchema} from '../../../shared/market-analysis-contracts';

const contentLabels=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'];
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function number(v:unknown,integer=false){const n=typeof v==='number'?v:typeof v==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v.trim())?Number(v):NaN;return Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER&&(!integer||Number.isSafeInteger(n))?n:null;}
function sum(values:Array<number|null>){if(values.some(v=>v===null))return null;const value=values.reduce<number>((a,b)=>a+b!,0);return Number.isFinite(value)&&value<=Number.MAX_SAFE_INTEGER?value:null;}
const share=(value:number|null,total:number|null)=>value!==null&&total!==null&&total>0?value/total*100:null;

/** Shares are recomputed over this response's declared disjoint rows only.
 * Upstream *Ratio fields are retained, never guessed to mean ratio or percent. */
export function normalizeMarketOverviewDistribution(operation:MarketOverviewDistributionOperation,payload:unknown,options:{currency?:'USD'}={}):MarketOverviewDistribution{
  operation=MarketOverviewDistributionOperationSchema.parse(operation);const envelope=obj(payload);
  if(envelope.isError===true||envelope.code!==undefined&&envelope.code!=='OK'||!Array.isArray(envelope.data)||envelope.data.length>2000)throw new TypeError('Invalid distribution response');
  const brand=operation==='market_brand_concentration',seller=operation==='market_seller_concentration',type=operation==='market_seller_type_concentration',content=operation==='market_ebc_distribution';
  const labelField=brand?'brand':seller?'sellerName':'label',unitsField=brand||seller?'totalUnits':'units',revenueField=brand||seller?'totalRevenue':'revenue';
  const rows:MarketOverviewDistribution['rows']=envelope.data.map((raw,index)=>{
    const r=obj(raw),issues:string[]=[],label=typeof r[labelField]==='string'&&r[labelField].trim().length&&r[labelField].length<=500?r[labelField].trim():'';
    if(!label)issues.push('invalid-label');
    let group:MarketOverviewDistribution['rows'][number]['group']='sample';
    if(content)group=contentLabels.includes(label)?'sample':contentLabels.some(l=>`新品${l}`===label)?'new-products':['A+','视频'].includes(label)?'summary':'unclassified';
    if(group==='unclassified')issues.push('unrecognized-content-group');
    let products=number(r[type?'asinNum':'products'],true);const units=number(r[unitsField],true),reportedRevenue=number(r[revenueField]);
    if(type&&r.productNum!==undefined&&number(r.productNum,true)!==products){products=null;issues.push('conflicting-product-count');}
    if(products===null)issues.push('invalid-products');if(units===null)issues.push('invalid-units');
    const revenue=options.currency==='USD'?reportedRevenue:null;
    if(r[revenueField]!==undefined&&r[revenueField]!==null&&(reportedRevenue===null||!options.currency))issues.push(reportedRevenue===null?'invalid-revenue':'revenue-currency-unverified');
    let asins:string[]=[];
    if(!content&&!type){if(!Array.isArray(r.asins)||r.asins.some(a=>typeof a!=='string'||!/^[A-Z0-9]{10}$/.test(a)))issues.push('invalid-membership');else asins=r.asins;
      if(new Set(asins).size!==asins.length||products!==asins.length)issues.push('membership-count-mismatch');}
    const reportedRates=Object.fromEntries(Object.entries(r).filter(([key])=>key.endsWith('Ratio')).map(([key,v])=>{const parsed=MarketInputRecordSchema.shape.data.safeParse(v);return [key,parsed.success?parsed.data:null];}));
    return {id:`row-${index}`,sourceIndex:index,label:label||`来源行 ${index+1}`,group,asins,products,units,revenue,reportedRevenue,reportedRates,productsSharePct:null,unitsSharePct:null,revenueSharePct:null,issues};
  });
  const groups:MarketOverviewDistribution['groups']=[];
  for(const id of (content?['sample','new-products']:['sample']) as Array<'sample'|'new-products'>){
    const members=rows.filter(r=>r.group===id),issues:string[]=[],asins=members.flatMap(r=>r.asins),labels=members.map(r=>r.label);
    if(new Set(labels).size!==labels.length)issues.push('duplicate-bucket');
    if(!content&&!type&&(members.some(r=>r.issues.some(i=>['invalid-membership','membership-count-mismatch'].includes(i)))||new Set(asins).size!==asins.length))issues.push('overlapping-or-invalid-membership');
    if(content&&(members.length!==4||contentLabels.some(l=>!labels.includes(id==='sample'?l:`新品${l}`))))issues.push('incomplete-content-combinations');
    if(rows.some(r=>r.group==='unclassified'))issues.push('unclassified-rows-excluded');
    if(members.some(r=>r.issues.includes('invalid-label')))issues.push('invalid-bucket');
    const invalid=issues.length>0,products=invalid||!members.length?null:sum(members.map(r=>r.products)),units=invalid||!members.length?null:sum(members.map(r=>r.units)),revenue=invalid||!members.length?null:sum(members.map(r=>r.revenue));
    if(products===null)issues.push('products-denominator-unavailable');if(units===null)issues.push('units-denominator-unavailable');
    for(const r of members){r.productsSharePct=share(r.products,products);r.unitsSharePct=share(r.units,units);r.revenueSharePct=share(r.revenue,revenue);}
    groups.push({id,basis:'returned-response-group',rowIds:members.map(r=>r.id),products,units,revenue,membership:invalid?'invalid':content||type?'provider-groups':'asin-disjoint',issues});
  }
  const issues=[...new Set([...rows.flatMap(r=>r.issues),...groups.flatMap(g=>g.issues)])];
  return MarketOverviewDistributionSchema.parse({version:MARKET_OVERVIEW_DISTRIBUTION_VERSION,operation,scopeBasis:'request-bound',status:!rows.length?'empty':issues.length?'partial':'available',currency:options.currency??null,rows,groups,issues});
}
