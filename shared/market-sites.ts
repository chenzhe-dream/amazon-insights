import {z} from 'zod';

// SellerSprite market APIs: https://open.sellersprite.com/appendix table 1.2.
// Restricted to the intersection with Sorftime keyword and Customers Say sites.
export const MarketSiteSchema=z.enum(['US','UK','DE','FR','IT','ES','JP','CA']);
export type MarketSite=z.infer<typeof MarketSiteSchema>;
export const MarketCurrencySchema=z.enum(['USD','GBP','EUR','JPY','CAD']);
export type MarketCurrency=z.infer<typeof MarketCurrencySchema>;
export const marketSites:readonly {code:MarketSite;label:string;currency:MarketCurrency;amazonDomain:string}[]=[
  {code:'US',label:'美国站',currency:'USD',amazonDomain:'amazon.com'},
  {code:'UK',label:'英国站',currency:'GBP',amazonDomain:'amazon.co.uk'},
  {code:'DE',label:'德国站',currency:'EUR',amazonDomain:'amazon.de'},
  {code:'FR',label:'法国站',currency:'EUR',amazonDomain:'amazon.fr'},
  {code:'IT',label:'意大利站',currency:'EUR',amazonDomain:'amazon.it'},
  {code:'ES',label:'西班牙站',currency:'EUR',amazonDomain:'amazon.es'},
  {code:'JP',label:'日本站',currency:'JPY',amazonDomain:'amazon.co.jp'},
  {code:'CA',label:'加拿大站',currency:'CAD',amazonDomain:'amazon.ca'},
];
export function marketSiteCurrency(site:MarketSite):MarketCurrency {
  return marketSites.find(entry=>entry.code===MarketSiteSchema.parse(site))!.currency;
}
export function sorftimeMarketSite(site:MarketSite):string {return site==='UK'?'GB':MarketSiteSchema.parse(site);}
/** Canonicalizes an identity for comparison; callers retain the provider payload. */
export function normalizeMarketSite(site:string):string {const value=site.trim().toUpperCase();return value==='GB'?'UK':value;}
export function marketSiteCurrencyMatches(scope:{marketplace:MarketSite;currency:MarketCurrency}):boolean {
  return marketSiteCurrency(scope.marketplace)===scope.currency;
}
