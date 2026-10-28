import {z} from 'zod';
import {MarketSiteSchema} from './market-sites';

export const MarketFavoriteModuleSchema=z.enum(['overview','shapes','keywords','themes']);
const month=z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
/** Only inert, validated state is saved. URLs, credentials and scope identities are not accepted. */
export const MarketFavoriteQuerySchema=z.strictObject({
 marketNode:z.string().min(1).max(240).regex(/^\d+(?::\d+)*$/).optional(),
 marketMonth:month.optional(),marketFrom:month.optional(),
 marketHead:z.enum(['5','10','20']).optional(),marketNew:z.enum(['1','3','6','12']).optional(),
 marketSite:MarketSiteSchema.optional(),
 overviewRun:z.string().uuid().optional(),shapeRun:z.string().uuid().optional(),
 keywordRun:z.string().uuid().optional(),themeRun:z.string().uuid().optional(),
});
export const MarketFavoriteKeywordInputSchema=z.strictObject({seeds:z.string().max(20_000),categoryContext:z.string().max(4_000),pageCount:z.number().int().min(1).max(100),maxMembers:z.number().int().min(1).max(2_000),sourceMode:z.literal('category-keywords').optional()});
export const MarketFavoriteCreateSchema=z.strictObject({id:z.string().uuid(),title:z.string().trim().min(1).max(120),module:MarketFavoriteModuleSchema,query:MarketFavoriteQuerySchema,keywordInput:MarketFavoriteKeywordInputSchema.optional()});
export const MarketFavoriteSchema=MarketFavoriteCreateSchema.extend({createdBy:z.string().uuid(),creatorName:z.string(),createdAt:z.string().datetime(),canDelete:z.boolean()});
export const MarketFavoriteListQuerySchema=z.strictObject({q:z.string().trim().max(120).default(''),page:z.coerce.number().int().min(1).max(1_000_000).default(1),module:MarketFavoriteModuleSchema.optional()});
export const MarketFavoriteListResponseSchema=z.strictObject({items:z.array(MarketFavoriteSchema).max(10),total:z.number().int().nonnegative(),page:z.number().int().positive(),pageSize:z.literal(10)});
export const MarketFavoriteCreateResponseSchema=z.strictObject({favorite:MarketFavoriteSchema});
export type MarketFavorite=z.infer<typeof MarketFavoriteSchema>;
export type MarketFavoriteKeywordInput=z.infer<typeof MarketFavoriteKeywordInputSchema>;
export type MarketFavoriteCreate=z.infer<typeof MarketFavoriteCreateSchema>;
export type MarketFavoriteListQuery=z.infer<typeof MarketFavoriteListQuerySchema>;
export type MarketFavoriteListResponse=z.infer<typeof MarketFavoriteListResponseSchema>;
