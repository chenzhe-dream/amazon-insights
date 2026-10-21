import { z } from "zod";

/** Public project identity; provider-specific marketplace codes are mapped separately. */
export const ProjectMarketplaceSchema = z.enum(["US", "UK", "DE", "CA"]);
export type ProjectMarketplace = z.infer<typeof ProjectMarketplaceSchema>;
