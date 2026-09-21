import { z } from 'zod';
import {MarketSiteSchema,MarketCurrencySchema,marketSiteCurrency,marketSiteCurrencyMatches,type MarketSite} from './market-sites';
export const MARKET_SHAPE_REQUEST_BOUND_CATALOG_VERSION = 'market-shape-price-catalog/v3' as const;
export const MARKET_PRODUCT_SOURCE_POLICY = { version: 'sellersprite-product-source-policy/v1', reviewedAt: '2026-09-13', provider: 'sellerSprite', operation: 'market_product_concentration', marketplace: 'US', currency: 'USD', historyMonths: 24,
    operationDocumentation: 'https://open.sellersprite.com/api/31', scopeDocumentation: 'https://open.sellersprite.com/appendix' } as const;
export const MarketProductSourcePolicySchema = z.object({ version: z.literal(MARKET_PRODUCT_SOURCE_POLICY.version), reviewedAt: z.literal(MARKET_PRODUCT_SOURCE_POLICY.reviewedAt), provider: z.literal('sellerSprite'), operation: z.literal('market_product_concentration'), marketplace: MarketSiteSchema, currency: MarketCurrencySchema, historyMonths: z.literal(24), operationDocumentation: z.literal(MARKET_PRODUCT_SOURCE_POLICY.operationDocumentation), scopeDocumentation: z.literal(MARKET_PRODUCT_SOURCE_POLICY.scopeDocumentation) }).strict().refine(marketSiteCurrencyMatches,'Product policy currency differs from marketplace');
export function marketProductSourcePolicy(marketplace:MarketSite){return {...MARKET_PRODUCT_SOURCE_POLICY,marketplace,currency:marketSiteCurrency(marketplace)};}
export const MarketProductScopeBasisSchema = z.enum(['response-verified', 'request-bound']);
export const MarketProductPriceProvenanceSchema = z.object({ scopeBasis: MarketProductScopeBasisSchema, currencyBasis: z.enum(['response-echo', 'provider-contract']) }).strict();
export const MarketProductMonthProvenanceSchema = z.object({ scopeBasis: MarketProductScopeBasisSchema, periodBasis: z.enum(['response-verified', 'request-bound', 'unsupported-month']) }).strict();
const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export function marketCalendarMonthIndex(value: string) { month.parse(value); return Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1; }
export function marketProductMonthSupported(queryMonth: string, observedAt: Date) {
    if (!Number.isFinite(observedAt.getTime()))
        throw new TypeError('Invalid product source date');
    const age = marketCalendarMonthIndex(observedAt.toISOString().slice(0, 7)) - marketCalendarMonthIndex(queryMonth);
    return age >= 1 && age <= MARKET_PRODUCT_SOURCE_POLICY.historyMonths;
}
export function assertMarketProductQueryWindow(scope: {
    fromMonth: string;
    toMonth: string;
}, at: Date) {
    if (scope.fromMonth > scope.toMonth || !marketProductMonthSupported(scope.fromMonth, at) || !marketProductMonthSupported(scope.toMonth, at))
        throw new RangeError('商品结构仅支持供应商最近24个完整月份，请调整研究周期。');
}
