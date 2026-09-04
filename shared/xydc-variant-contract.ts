import { z } from "zod";

export const XydcVariantAttributeSchema = z.strictObject({
  dimension: z.string().min(1),
  value: z.string().min(1),
});

export const XydcVariantChildSchema = z.strictObject({
  asin: z.string().regex(/^[A-Z0-9]{10}$/),
  attributes: z.array(XydcVariantAttributeSchema),
  title: z.string().min(1).nullable(),
  imageUrl: z.string().url().nullable(),
  price: z.number().nonnegative().nullable(),
  currency: z.string().min(1).nullable(),
  stars: z.number().min(0).max(5).nullable(),
  productPageRatings: z.number().int().nonnegative().nullable(),
  listingDate: z.null(),
  infoStatus: z.enum(["ready", "pending", "unavailable"]),
});

export const XydcVariantFamilySchema = z.strictObject({
  inputAsin: z.string().regex(/^[A-Z0-9]{10}$/),
  country: z.string().min(2).max(8),
  parentAsin: z.string().regex(/^[A-Z0-9]{10}$/),
  dimensions: z.array(z.string().min(1)),
  children: z.array(XydcVariantChildSchema),
  sourceUpdatedAt: z.string().min(1).nullable(),
  fetchedAt: z.string().datetime(),
  status: z.enum(["ready", "partial", "unavailable"]),
  reasonCode: z.enum([
    "NOT_CONFIGURED", "AUTH_FAILED", "TIMEOUT", "RPC_ERROR",
    "SCHEMA_INVALID", "NOT_FOUND", "PARTIAL_CHILD_INFO",
  ]).nullable(),
  cacheState: z.enum(["fresh", "stale"]),
});

export type XydcVariantFamily = z.infer<typeof XydcVariantFamilySchema>;
export type XydcVariantReasonCode = NonNullable<XydcVariantFamily["reasonCode"]>;
