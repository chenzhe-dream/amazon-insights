import {z} from 'zod';
import {MarketCurrencySchema} from './market-sites';
import {MarketInputRecordSchema} from './market-analysis-contracts';

export const MARKET_OVERVIEW_DISTRIBUTION_VERSION='market-overview-distributions/v1';
export const MARKET_OVERVIEW_DISTRIBUTION_OPERATIONS=[
  'market_price_distribution','market_ratings_count_distribution','market_rating_distribution',
  'market_listing_date_distribution','market_listing_trend_distribution','market_brand_concentration',
  'market_seller_concentration','market_seller_country_distribution','market_seller_type_concentration','market_ebc_distribution',
] as const;
export const MARKET_OVERVIEW_PRODUCT_OPERATION='market_product_concentration' as const;
export const MarketOverviewDistributionOperationSchema=z.enum([...MARKET_OVERVIEW_DISTRIBUTION_OPERATIONS,MARKET_OVERVIEW_PRODUCT_OPERATION]);
export type MarketOverviewDistributionOperation=z.infer<typeof MarketOverviewDistributionOperationSchema>;
const number=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),count=number.int(),percent=z.number().finite().min(0).max(100).nullable();
const group=z.enum(['sample','new-products','summary','unclassified']);
export const MarketOverviewDistributionSchema=z.object({
  version:z.literal(MARKET_OVERVIEW_DISTRIBUTION_VERSION),operation:MarketOverviewDistributionOperationSchema,
  scopeBasis:z.literal('request-bound'),status:z.enum(['available','partial','empty']),currency:MarketCurrencySchema.nullable(),
  rows:z.array(z.object({id:z.string(),sourceIndex:count,label:z.string(),group,asins:z.array(z.string()),
    productItems:z.array(z.object({asin:z.string(),title:z.string().nullable(),units:count.nullable(),imageUrl:z.string().nullable()}).strict()).max(2000).optional(),
    products:count.nullable(),units:count.nullable(),revenue:number.nullable(),reportedRevenue:number.nullable(),
    productsSharePct:percent,unitsSharePct:percent,revenueSharePct:percent,
    reportedRates:z.record(z.string(),MarketInputRecordSchema.shape.data),issues:z.array(z.string()),
  }).strict()).max(2000),
  groups:z.array(z.object({id:z.enum(['sample','new-products']),basis:z.literal('returned-response-group'),rowIds:z.array(z.string()),
    products:count.nullable(),units:count.nullable(),revenue:number.nullable(),membership:z.enum(['asin-disjoint','provider-groups','invalid']),issues:z.array(z.string()),
  }).strict()),issues:z.array(z.string()),
}).strict();
export type MarketOverviewDistribution=z.infer<typeof MarketOverviewDistributionSchema>;
export const MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION='market-overview-source-catalog/v4';
export const MARKET_OVERVIEW_ADDITIONAL_OPERATIONS=[...MARKET_OVERVIEW_DISTRIBUTION_OPERATIONS,'market_product_demand_trend'] as const;
export const MARKET_OVERVIEW_ALL_OPERATIONS=['market_research','market_research_statistics',...MARKET_OVERVIEW_ADDITIONAL_OPERATIONS] as const;
export const MARKET_OVERVIEW_ADDITIONAL_OPERATIONS_V2=[...MARKET_OVERVIEW_ADDITIONAL_OPERATIONS,MARKET_OVERVIEW_PRODUCT_OPERATION] as const;
export const MARKET_OVERVIEW_ALL_OPERATIONS_V2=[...MARKET_OVERVIEW_ALL_OPERATIONS,MARKET_OVERVIEW_PRODUCT_OPERATION] as const;
export const MarketOverviewExpandedSourceFailureSchema=z.object({month:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),operation:z.enum(MARKET_OVERVIEW_ALL_OPERATIONS),attemptId:z.string().uuid(),code:z.string().min(1).max(100)}).strict();
export type MarketOverviewExpandedSourceFailure=z.infer<typeof MarketOverviewExpandedSourceFailureSchema>;
export const MarketOverviewExpandedSourceFailureV2Schema=MarketOverviewExpandedSourceFailureSchema.extend({operation:z.enum(MARKET_OVERVIEW_ALL_OPERATIONS_V2)}).strict();
export type MarketOverviewExpandedSourceFailureV2=z.infer<typeof MarketOverviewExpandedSourceFailureV2Schema>;
export const MarketOverviewDistributionEntrySchema=z.object({
  month:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),operation:z.enum(MARKET_OVERVIEW_ADDITIONAL_OPERATIONS_V2),
  status:z.enum(['ready','partial','empty','failed','not-collected']),sourceRef:z.string().nullable(),fetchedAt:z.string().datetime().nullable(),
  scopeBasis:z.enum(['request-bound','response-verified']).nullable(),distribution:MarketOverviewDistributionSchema.nullable(),
  issues:z.array(z.object({code:z.string(),retryable:z.boolean()}).strict()),
}).strict();
export type MarketOverviewDistributionEntry=z.infer<typeof MarketOverviewDistributionEntrySchema>;
