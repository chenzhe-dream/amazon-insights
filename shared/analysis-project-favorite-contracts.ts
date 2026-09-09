import { z } from "zod";

export const FavoriteIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
export const FavoriteParamsSchema = z.object({ id: FavoriteIdSchema }).strict();
export const FavoriteEmptySchema = z.object({}).strict();
export const AnalysisFavoritesResponseSchema = z.object({ projectIds: z.array(FavoriteIdSchema) }).strict();
export const AnalysisFavoriteResponseSchema = z.object({ projectId: FavoriteIdSchema, favorited: z.boolean() }).strict();
