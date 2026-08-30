import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  AsinSchema,
  DateTimeSchema,
  ManualAlexaVocNormalizedRecordSchema,
  ManualAlexaVocRecordSchema,
  Sha256Schema,
  type ManualAlexaVocRecord,
} from "../../shared/agent-contracts";
import {
  deepFreeze,
  normalizeRepositoryDateOnlyUtc,
} from "./voc-data-snapshot";

export const LEGACY_MANUAL_VOC_OWNER_MANIFEST_SCHEMA_VERSION =
  "manual-voc-owner-manifest/v1" as const;

const DecimalStringSchema = z.string().regex(/^[1-9]\d*$/);
const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  value => {
    try {
      normalizeRepositoryDateOnlyUtc(value);
      return true;
    } catch {
      return false;
    }
  },
  "Expected a valid UTC calendar date",
);
const LegacyCapturedAtSchema = z.union([DateTimeSchema, DateOnlySchema]);

export const LegacyManualVocOwnerManifestRecordSchema = z.strictObject({
  revision: DecimalStringSchema,
  contentHash: Sha256Schema,
  capturedAt: LegacyCapturedAtSchema,
  generation: DecimalStringSchema,
});

export const LegacyManualVocOwnerManifestSchema = z.strictObject({
  schemaVersion: z.literal(LEGACY_MANUAL_VOC_OWNER_MANIFEST_SCHEMA_VERSION),
  ownerOrganizationId: z.string().trim().min(1).max(200),
  marketplace: z.literal("US"),
  artifactGeneration: DecimalStringSchema,
  sourceHeadsHash: Sha256Schema,
  generatedAt: DateTimeSchema,
  records: z.record(AsinSchema, LegacyManualVocOwnerManifestRecordSchema),
});

export type LegacyManualVocOwnerManifest = z.infer<
  typeof LegacyManualVocOwnerManifestSchema
>;

export type LegacyGateResult =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      reason:
        | "owner_mismatch"
        | "marketplace_mismatch"
        | "owner_missing"
        | "config_missing"
        | "schema_mismatch"
        | "generation_mismatch";
    }>;

export type LegacyManualAlexaVocData = Readonly<{
  capturedAt: string;
  marketplace: "US";
  data: Readonly<Record<string, unknown>>;
}>;

export type LegacyManualAlexaVocReadInput = Readonly<{
  principalOrg: string;
  marketplace: "US";
  asin: string;
  dataCutoffAt: string;
}>;

export type LegacyManualAlexaVocReadResult =
  | Readonly<{
      status: "ready";
      source: "legacy-static-stale" | "legacy-static-date-only";
      record: ManualAlexaVocRecord;
    }>
  | Readonly<{
      status: "missing";
      reason: "not-found" | "pending" | "source-error" | "after-cutoff";
    }>
  | Readonly<{
      status: "ineligible";
      reason: Exclude<LegacyGateResult, { allowed: true }>["reason"];
    }>;

export interface LegacyManualAlexaVocSourceReader {
  readIfEligible(
    input: LegacyManualAlexaVocReadInput,
  ): Promise<LegacyManualAlexaVocReadResult>;
}

export function LegacyVocReadEligibilityGate(
  principalOrg: string,
  marketplace: "US",
  manifest: LegacyManualVocOwnerManifest | null,
): LegacyGateResult {
  if (!manifest) {
    return validConfiguredDefaultOrganization(
      process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID,
    )
      ? { allowed: false, reason: "owner_missing" }
      : { allowed: false, reason: "config_missing" };
  }
  const candidate = manifest as unknown as Record<string, unknown>;
  if (
    candidate.schemaVersion !==
    LEGACY_MANUAL_VOC_OWNER_MANIFEST_SCHEMA_VERSION
  ) {
    return { allowed: false, reason: "schema_mismatch" };
  }
  if (
    typeof candidate.ownerOrganizationId !== "string" ||
    !candidate.ownerOrganizationId.trim()
  ) {
    return { allowed: false, reason: "owner_missing" };
  }
  if (candidate.marketplace !== marketplace) {
    return { allowed: false, reason: "marketplace_mismatch" };
  }
  const parsed = LegacyManualVocOwnerManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    return { allowed: false, reason: "schema_mismatch" };
  }
  if (
    Object.values(parsed.data.records).some(
      record => record.generation !== parsed.data.artifactGeneration,
    )
  ) {
    return { allowed: false, reason: "generation_mismatch" };
  }
  if (parsed.data.ownerOrganizationId !== principalOrg) {
    return { allowed: false, reason: "owner_mismatch" };
  }
  return { allowed: true };
}

export class LegacyManualAlexaVocSource
  implements LegacyManualAlexaVocSourceReader
{
  readonly #loadManifest: () => Promise<unknown>;
  readonly #loadLegacyData: () => Promise<LegacyManualAlexaVocData>;

  constructor(options: Readonly<{
    loadManifest?: () => Promise<unknown>;
    loadLegacyData?: () => Promise<LegacyManualAlexaVocData>;
    manifestPath?: string | null;
  }> = {}) {
    this.#loadManifest =
      options.loadManifest ??
      (() => loadLegacyManualVocOwnerManifest(
        options.manifestPath ??
          process.env.LEGACY_VOC_OWNER_MANIFEST_PATH ??
          null,
      ));
    this.#loadLegacyData =
      options.loadLegacyData ?? loadStaticLegacyManualAlexaVocData;
  }

  async readIfEligible(
    input: LegacyManualAlexaVocReadInput,
  ): Promise<LegacyManualAlexaVocReadResult> {
    const asin = AsinSchema.parse(input.asin.trim().toUpperCase());
    const cutoff = new Date(DateTimeSchema.parse(input.dataCutoffAt)).toISOString();
    let untrustedManifest: unknown;
    try {
      untrustedManifest = await this.#loadManifest();
    } catch {
      return deepFreeze({ status: "missing", reason: "source-error" });
    }
    const manifestCandidate =
      untrustedManifest && typeof untrustedManifest === "object"
        ? untrustedManifest as LegacyManualVocOwnerManifest
        : null;
    const gate = LegacyVocReadEligibilityGate(
      input.principalOrg,
      input.marketplace,
      manifestCandidate,
    );
    if (!gate.allowed) {
      return deepFreeze({ status: "ineligible", reason: gate.reason });
    }
    const manifest = LegacyManualVocOwnerManifestSchema.parse(manifestCandidate);
    const metadata = manifest.records[asin];
    if (!metadata) {
      return deepFreeze({ status: "missing", reason: "not-found" });
    }

    const dateOnly = DateOnlySchema.safeParse(metadata.capturedAt).success;
    const capturedAt = dateOnly
      ? normalizeRepositoryDateOnlyUtc(metadata.capturedAt)
      : new Date(DateTimeSchema.parse(metadata.capturedAt)).toISOString();
    if (capturedAt > cutoff) {
      return deepFreeze({ status: "missing", reason: "after-cutoff" });
    }

    let legacy: LegacyManualAlexaVocData;
    try {
      legacy = await this.#loadLegacyData();
    } catch {
      return deepFreeze({ status: "missing", reason: "source-error" });
    }
    if (legacy.marketplace !== input.marketplace) {
      return deepFreeze({ status: "missing", reason: "source-error" });
    }
    const raw = legacy.data[asin];
    if (!raw || typeof raw !== "object") {
      return deepFreeze({ status: "missing", reason: "not-found" });
    }
    if (Reflect.get(raw, "captureStatus") === "pending") {
      return deepFreeze({ status: "missing", reason: "pending" });
    }
    const normalizedRecord = ManualAlexaVocNormalizedRecordSchema.safeParse({
      ...raw,
      asin,
    });
    if (!normalizedRecord.success) {
      return deepFreeze({ status: "missing", reason: "source-error" });
    }
    const record = ManualAlexaVocRecordSchema.parse({
      asin,
      marketplace: input.marketplace,
      revision: metadata.revision,
      normalizedRecord: normalizedRecord.data,
      source: "legacy-static-stale",
      generation: metadata.generation,
      capturedAt,
    });
    return deepFreeze({
      status: "ready",
      source: dateOnly
        ? "legacy-static-date-only"
        : "legacy-static-stale",
      record,
    });
  }
}

export async function loadLegacyManualVocOwnerManifest(
  manifestPath: string | null,
): Promise<unknown> {
  if (!manifestPath?.trim()) return null;
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

export async function loadStaticLegacyManualAlexaVocData(): Promise<
  LegacyManualAlexaVocData
> {
  const legacy = await import("../../app/rufus-voc-data");
  return deepFreeze({
    capturedAt: legacy.rufusVocMeta.capturedAt,
    marketplace: "US",
    data: legacy.rufusVocData,
  });
}

function validConfiguredDefaultOrganization(value: string | undefined) {
  return Boolean(
    value &&
      value !== "*" &&
      value.trim() === value &&
      value.length <= 200,
  );
}

function isFileNotFound(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      Reflect.get(error, "code") === "ENOENT",
  );
}
