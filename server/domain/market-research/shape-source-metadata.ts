import {z} from 'zod';
import {MarketShapeSourceMetadataSchema,type MarketShapeSourceMetadata} from '../../../shared/market-shape-source-metadata-contracts';
import type {readMarketProductMonth} from './product-month-evidence';
import {marketProductSourceAdmission} from './product-source-admission';
type Checked=Awaited<ReturnType<typeof readMarketProductMonth>>;
/** Whitelist only frozen normalized fields. Never fetch, infer revenue, or reinterpret old admission. */
export function projectMarketShapeSourceMetadata(checked:Checked,asin:string,requestBound:boolean):MarketShapeSourceMetadata {
 const p=checked.products.find(p=>p.asin===asin);if(!p)throw new TypeError('Metadata product is outside saved source');
 const raw=(checked.source.payload as {data:Record<string,unknown>[]}).data[p.sourceIndex],proof=requestBound?marketProductSourceAdmission(checked,asin):null;
 const scopeIssues:MarketShapeSourceMetadata['revenue']['issues']=proof||p.scopeConfirmed?[]:['scope-unconfirmed'];
 const evidence=(field:MarketShapeSourceMetadata['revenue']['evidence']['payloadPath'][2])=>({sourceRef:checked.observation.sourceRef,inputSnapshotId:checked.observation.snapshot.snapshotId,payloadPath:['data',p.sourceIndex,field]});
 const field=(name:Parameters<typeof evidence>[0],input:number|string|null,extra:MarketShapeSourceMetadata['revenue']['issues']=[])=>{const value=typeof input==='string'&&input.length>4000?null:input;const issues=[...scopeIssues,...extra,...(value===null?[raw[name]==null||raw[name]===''?'missing':'invalid']:[])];return {rawValue:value,value:issues.length?null:value,issues,evidence:evidence(name)}};
 const revenueIssues:MarketShapeSourceMetadata['revenue']['issues']=[...(!proof&&!p.currencyConfirmed?['currency-unconfirmed' as const]:[]),...(!proof&&!p.periodConfirmed?['period-unconfirmed' as const]:[]),...(proof?.periodBasis==='unsupported-month'?['period-outside-provider-history' as const]:[])];
 const date=z.string().date().safeParse(raw.shelfDate),validDate=date.success&&Number.isFinite(Date.parse(date.data))&&new Date(date.data).toISOString().slice(0,10)===date.data?date.data:null;
 return MarketShapeSourceMetadataSchema.parse({basis:'reference-observation',referenceMonth:checked.observation.month,revenue:field('totalRevenue',p.revenue,revenueIssues),rating:field('rating',p.rating),ratingCount:field('ratings',p.ratingCount),sellerName:field('sellerName',p.sellerName),sellerType:field('sellerType',p.sellerType),listedAt:field('shelfDate',validDate,validDate&&validDate.slice(0,7)>checked.observation.month?['listed-after-reference-month']:[])});
}
