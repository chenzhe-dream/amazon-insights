import {z} from 'zod';
import {MarketStudyRequestSchema} from './market-module-contracts';
import {MarketShapeStartRequestSchema} from './market-shape-price-contracts';
export const MarketShapeQueryRequestSchema=z.object({scope:MarketStudyRequestSchema,params:MarketShapeStartRequestSchema,forceRefresh:z.boolean().default(false)}).strict();
