import { z } from "zod";

export const GOVERNED_RESOURCES = [
  "wholeJob",
  "sellerSprite",
  "sif",
  "sorftime",
  "model",
  "image",
] as const;

export const GOVERNED_ATTEMPT_KINDS = [
  "initial",
  "retry",
  "repair",
  "probe",
  "quota-refresh",
] as const;

export type GovernedResource = (typeof GOVERNED_RESOURCES)[number];
export type GovernedAttemptKind = (typeof GOVERNED_ATTEMPT_KINDS)[number];
export type ConcurrencyProfileName = "conservative" | "standard" | "fast";

export interface ConcurrencyPolicy {
  readonly version: string;
  readonly profile: ConcurrencyProfileName;
  readonly limits: Readonly<Record<GovernedResource, number>>;
  readonly sellerSpriteRolling: Readonly<{
    maxAttempts: number;
    windowMs: number;
  }>;
}

export const CONSERVATIVE_CONCURRENCY_PROFILE: ConcurrencyPolicy = Object.freeze({
  version: "conservative-v1",
  profile: "conservative",
  limits: Object.freeze({
    wholeJob: 2,
    sellerSprite: 1,
    sif: 1,
    sorftime: 1,
    model: 1,
    image: 1,
  }),
  sellerSpriteRolling: Object.freeze({
    maxAttempts: 15,
    windowMs: 60_000,
  }),
});

export const STANDARD_CONCURRENCY_PROFILE: ConcurrencyPolicy = Object.freeze({
  version: "standard-v2",
  profile: "standard",
  limits: Object.freeze({
    wholeJob: 4,
    sellerSprite: 2,
    sif: 1,
    sorftime: 1,
    model: 2,
    image: 4,
  }),
  sellerSpriteRolling: Object.freeze({
    maxAttempts: 30,
    windowMs: 60_000,
  }),
});

export const FAST_CONCURRENCY_PROFILE: ConcurrencyPolicy = Object.freeze({
  version: "fast-v1",
  profile: "fast",
  limits: Object.freeze({
    wholeJob: 6,
    sellerSprite: 3,
    sif: 2,
    sorftime: 2,
    model: 3,
    image: 3,
  }),
  sellerSpriteRolling: Object.freeze({
    maxAttempts: 30,
    windowMs: 60_000,
  }),
});

export const BOOTSTRAP_CONCURRENCY_PROFILES = Object.freeze([
  CONSERVATIVE_CONCURRENCY_PROFILE,
  STANDARD_CONCURRENCY_PROFILE,
  FAST_CONCURRENCY_PROFILE,
]);

const policySchema = z.strictObject({
  version: z.string().trim().min(1).max(100),
  profile: z.enum(["conservative", "standard", "fast"]),
  limits: z.strictObject({
    wholeJob: z.number().int().positive(),
    sellerSprite: z.number().int().positive(),
    sif: z.number().int().positive(),
    sorftime: z.number().int().positive(),
    model: z.number().int().positive(),
    image: z.number().int().positive(),
  }),
  sellerSpriteRolling: z.strictObject({
    maxAttempts: z.number().int().positive(),
    windowMs: z.number().int().positive(),
  }),
});

export function parseConcurrencyPolicy(value: unknown): ConcurrencyPolicy {
  const parsed = policySchema.parse(value);
  return Object.freeze({
    version: parsed.version,
    profile: parsed.profile,
    limits: Object.freeze(parsed.limits),
    sellerSpriteRolling: Object.freeze(parsed.sellerSpriteRolling),
  });
}

export function resourceLimitColumn(resource: GovernedResource): string {
  switch (resource) {
    case "wholeJob":
      return "whole_job_limit";
    case "sellerSprite":
      return "seller_sprite_concurrency";
    case "sif":
      return "sif_concurrency";
    case "sorftime":
      return "sorftime_concurrency";
    case "model":
      return "model_concurrency";
    case "image":
      return "image_concurrency";
  }
}
