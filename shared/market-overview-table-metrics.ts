import {z} from 'zod';
const value=z.number().finite().nonnegative().nullable();
/** Percent values follow the original interface: CR/new ratios normalize only research 0..1. */
export const MarketOverviewTableMetricsSchema=z.object({
  hlAvgUnits:value,hlAvgRevenue:value,avgRevenue:value,avgBsr:value,hlAvgBsr:value,avgSellers:value,
  productCrn:value,brandCrn:value,sellerCrn:value,newRatio:value,
  fbaProportion:value,amazonSelfProportion:value,fbmProportion:value,totalProducts:value,returnRatio:value,avgReturnRatio:value,
}).strict();
export type MarketOverviewTableMetrics=z.infer<typeof MarketOverviewTableMetricsSchema>;
