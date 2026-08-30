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
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";

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
  bindingAuditId: z.string().trim().min(1).max(200),
  bindingActorUserId: z.string().trim().min(1).max(200),
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
  artifactGeneration: string;
  capturedAt: string;
  recordCapturedAt?: Readonly<Record<string, string>>;
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
      contentHash: string;
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
  const configuredOwner = process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID;
  if (!validConfiguredDefaultOrganization(configuredOwner)) {
    return { allowed: false, reason: "config_missing" };
  }
  if (!manifest) {
    return { allowed: false, reason: "owner_missing" };
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
  if (
    canonicalJsonSha256(parsed.data.records) !== parsed.data.sourceHeadsHash
  ) {
    return { allowed: false, reason: "schema_mismatch" };
  }
  if (
    parsed.data.ownerOrganizationId !== configuredOwner ||
    parsed.data.ownerOrganizationId !== principalOrg
  ) {
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
    const verified = verifyLegacyArtifact(manifest, legacy);
    if (!verified) {
      return deepFreeze({ status: "missing", reason: "source-error" });
    }
    const normalizedRecord = verified.get(asin);
    if (!normalizedRecord) {
      return deepFreeze({ status: "missing", reason: "not-found" });
    }
    const record = ManualAlexaVocRecordSchema.parse({
      asin,
      marketplace: input.marketplace,
      revision: metadata.revision,
      normalizedRecord,
      source: "legacy-static-stale",
      generation: metadata.generation,
      capturedAt,
    });
    return deepFreeze({
      status: "ready",
      source: dateOnly
        ? "legacy-static-date-only"
        : "legacy-static-stale",
      contentHash: metadata.contentHash,
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
    artifactGeneration: "1",
    capturedAt: legacy.rufusVocMeta.capturedAt,
    marketplace: "US",
    data: legacy.rufusVocData,
  });
}

function verifyLegacyArtifact(
  manifest: LegacyManualVocOwnerManifest,
  legacy: LegacyManualAlexaVocData,
) {
  if (legacy.artifactGeneration !== manifest.artifactGeneration) return null;
  const verified = new Map<string, z.infer<typeof ManualAlexaVocNormalizedRecordSchema>>();
  const actualDialogAsins = Object.entries(legacy.data).flatMap(([asin, raw]) =>
    raw && typeof raw === "object" && Reflect.get(raw, "captureStatus") === "dialog"
      ? [asin]
      : [],
  );
  if (
    actualDialogAsins.length !== Object.keys(manifest.records).length ||
    actualDialogAsins.some(asin => !manifest.records[asin])
  ) {
    return null;
  }
  const verifiedHeads: Record<string, z.infer<typeof LegacyManualVocOwnerManifestRecordSchema>> = {};
  for (const [asin, metadata] of Object.entries(manifest.records)) {
    const raw = legacy.data[asin];
    if (!raw || typeof raw !== "object") return null;
    const normalized = ManualAlexaVocNormalizedRecordSchema.safeParse({ ...raw, asin });
    if (!normalized.success) return null;
    const actualCapturedAt = legacy.recordCapturedAt?.[asin] ?? legacy.capturedAt;
    if (
      canonicalLegacyCapturedAt(actualCapturedAt) !==
        canonicalLegacyCapturedAt(metadata.capturedAt) ||
      canonicalJsonSha256(normalized.data) !== metadata.contentHash ||
      metadata.generation !== legacy.artifactGeneration
    ) {
      return null;
    }
    verified.set(asin, normalized.data);
    verifiedHeads[asin] = metadata;
  }
  return canonicalJsonSha256(verifiedHeads) === manifest.sourceHeadsHash
    ? verified
    : null;
}

function canonicalLegacyCapturedAt(value: string) {
  return DateOnlySchema.safeParse(value).success
    ? normalizeRepositoryDateOnlyUtc(value)
    : new Date(DateTimeSchema.parse(value)).toISOString();
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
