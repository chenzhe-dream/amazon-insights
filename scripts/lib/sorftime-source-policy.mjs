import {createHash} from 'node:crypto';
import {sharedProviderTtl} from './shared-provider-source-policy.mjs';

const hour = 3600_000;
// Reviewed against Sorftime MCP docs on 2026-10-14. These are estimates, not receipts.
const costs = Object.freeze({
  product_detail:1, product_content:1, product_customers_say:1, product_reviews:5,
  product_variations:2, product_search:2, product_search_from_history:2,
  product_search_from_name:2, product_traffic_terms:1, competitor_product_keywords:1,
  product_ranking_trend_by_keyword:1, category_products:10, category_report:2,
  category_report_from_history:5, category_trend:1, category_keywords:1,
  category_name_search:1, category_search_from_product_name:1,
  category_search_from_top_node:1, category_tree:1, search_categories_broadly:1,
  category_low_price_search:2,
});
const extraReads = new Set(['keyword_extends','keyword_trend']);
export function estimateSorftimeCost(tool, args = {}) {
  if(tool==='product_trend') return args.type==='BsrRank'?10:5;
  return costs[tool] ?? null;
}
export function cacheTtl(tool, payload, provider = 'sorftime') {
  if(provider !== 'sorftime') return sharedProviderTtl(provider, tool, payload);
  if(!(tool in costs) && tool!=='product_trend' && !extraReads.has(tool)) return 0;
  const data=payload?.data ?? payload;
  if(Array.isArray(data)&&data.length===0 || Array.isArray(data?.details)&&data.details.length===0) return 300_000;
  if(tool==='product_content') return 7*24*hour;
  if(tool==='product_detail'||tool==='product_variations') return 6*hour;
  return 24*hour;
}
function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));
  return value;
}
const hash=value=>createHash('sha256').update(value).digest('hex');
export function sourceIdentity({key,endpoint,tool,args,provider='sorftime'}) {
  if(!['sorftime','sellerSprite','sif'].includes(provider)) throw new Error('Unknown source provider');
  if(typeof key!=='string'||!key.trim()) throw new Error('Sorftime credential is not configured');
  const credentialScope=hash(JSON.stringify([`${provider}-source/v1`,endpoint,key]));
  const id=hash(JSON.stringify([credentialScope,tool,canonical(args)]));
  return {id,credentialScope,operation:provider==='sorftime'?tool:`${provider}/${tool}`};
}
export class SorftimeQuotaError extends Error {
  constructor(provider='Sorftime'){super(`${provider} quota exhausted; uncached requests paused`);this.name='SorftimeQuotaError';this.kind='quota';this.doNotRetry=true;}
}
export class SorftimeSourceWaitError extends Error {
  constructor(){super('Sorftime shared source temporarily unavailable');this.name='SorftimeSourceWaitError';this.doNotRetry=true;}
}
export function isQuotaResponse(value) {
  // Look only at error fields / MCP text, never ordinary product-review content.
  const text=value?.isError===true
    ? JSON.stringify(value.content??value.error??'')
    : typeof value?.error==='string'?value.error:typeof value?.message==='string'&&(value.success===false||value.code!==undefined)?value.message:'';
  return /MCP使用次数.{0,12}(?:上限|耗尽)|额度.{0,12}(?:不足|耗尽|用完)|(?:quota|credits?).{0,24}(?:exhausted|exceeded|insufficient)|insufficient.{0,12}(?:quota|credits?)/i.test(text);
}
export function assertSourceResponse(value, provider='Sorftime') {
  if(isQuotaResponse(value)) throw new SorftimeQuotaError(provider);
  if(!value||typeof value!=='object'||value.isError===true||value.error||value.success===false||
    value.code!==undefined&&!['OK',200,'200',0,'0'].includes(value.code)) {
    const error=new Error(`${provider} source returned an invalid or unsuccessful response`);
    error.doNotRetry=true;throw error;
  }
}
const metadata=new WeakMap();
export function attachSourceMetadata(value, info) {if(value&&typeof value==='object')metadata.set(value,Object.freeze(info));return value;}
export function sourceMetadata(value){return value&&typeof value==='object'?metadata.get(value):undefined;}
/** Preserve existing date-only consumer contracts; choose the oldest contributing source. */
export function sourceFetchedDate(values, fallback) {
  const dates=values.map(value=>sourceMetadata(value)?.fetchedAt).filter(Boolean).sort();
  return dates.length?dates[0].slice(0,10):fallback;
}
