import type { readMarketProductMonth } from './product-month-evidence';
import { marketProductMonthSupported, type MarketProductScopeBasisSchema } from '../../../shared/market-product-source-policy';
import type { z } from 'zod';
/** Call only after readMarketProductMonth has replayed the immutable payload.
 * Query semantics come from the audited provider contract, never an invented
 * response echo. The original source evidence and units remain untouched. */
export function marketProductSourceAdmission(checked: Awaited<ReturnType<typeof readMarketProductMonth>>, asin: string) {
    const { source, observation } = checked, scope = observation.snapshot.scope, p = checked.products.find(p => p.asin === asin);
    if (!p || source.provider !== 'sellerSprite' || source.operation !== 'market_product_concentration' || scope.marketplace !== 'US' || scope.currency !== 'USD' || source.requestIdentity.marketplace !== scope.marketplace || source.requestIdentity.nodeIdPath !== scope.nodeIdPath || source.requestIdentity.month !== observation.month)
        throw new TypeError('Product source is outside the documented request contract');
    const scopeBasis: z.infer<typeof MarketProductScopeBasisSchema> = p.scopeConfirmed ? 'response-verified' : 'request-bound';
    return { scopeBasis, currencyBasis: p.currencyConfirmed ? 'response-echo' as const : 'provider-contract' as const,
        periodBasis: !marketProductMonthSupported(observation.month, new Date(source.fetchedAt)) ? 'unsupported-month' as const : p.periodConfirmed ? 'response-verified' as const : 'request-bound' as const };
}
