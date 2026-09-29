import type {MarketShapeProductImagesPublic} from './market-shape-product-image-contracts';

const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const number=(v:unknown)=>typeof v==='number'||typeof v==='string'&&/^-?\d+(?:\.\d+)?$/.test(v.trim())?Number(v):NaN;

/** Sorftime product_detail declares gross_profit_rate as a percentage value. Never derive it from fees. */
export function parseSorftimeMarginObservation(raw:unknown,asin:string){
 const envelope=object(raw),data=object(envelope.data??raw);
 if(data.asin!==asin)return null;
 const grossProfitMargin=number(data.gross_profit_rate),price=number(data.price);
 if(!Number.isFinite(grossProfitMargin)||grossProfitMargin < -1000||grossProfitMargin>100||!Number.isFinite(price)||price<=0||price>Number.MAX_SAFE_INTEGER)return null;
 return {grossProfitMargin,price};
}

type Detail=MarketShapeProductImagesPublic['products'][number];
export function resolveShapeMarginObservation(product:{asin:string;price:number|null;grossProfitMargin:number|null},detail:Detail|undefined){
 if(product.grossProfitMargin!==null)return {value:product.grossProfitMargin,basis:'pool' as const,note:'Sorftime 商品池毛利润率'};
 const observation=detail?.marginObservation;
 if(!detail||detail.asin!==product.asin||!['ready','empty'].includes(detail.status)||!detail.sourceRef||!detail.fetchedAt||!observation)
  return {value:null,basis:'missing' as const,note:detail?.status==='failed'?'商品详情采集失败，暂无可用毛利润率；可在任务详情重试':detail?.status==='queued'||detail?.status==='running'?'商品详情尚在采集中，暂无可用毛利润率':'当前报告没有可采用的毛利润率；缺失不按0计算'};
 if(product.price===null||product.price<=0||product.price!==observation.price)
  return {value:null,basis:'price-mismatch' as const,note:`详情售价与商品池售价不同或无法确认（详情 ${observation.price}，商品池 ${product.price??'未知'}），未混用毛利润率`};
 return {value:observation.grossProfitMargin,basis:'detail' as const,note:`Sorftime 商品详情毛利润率；同ASIN、同售价 ${observation.price}；采集于 ${detail.fetchedAt}`};
}
