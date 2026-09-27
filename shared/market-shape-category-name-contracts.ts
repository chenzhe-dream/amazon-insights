import {z} from 'zod';
import {MarketSiteSchema} from './market-sites';

export const ShapeCategoryNameRequestSchema=z.object({marketplace:MarketSiteSchema,name:z.string().trim().min(1).max(160).regex(/^[\x20-\x7e]+$/).refine(name=>/[A-Za-z]/.test(name))}).strict();
export const ShapeCategoryNameResponseSchema=z.object({nodeId:z.string().regex(/^\d+$/)}).strict();
