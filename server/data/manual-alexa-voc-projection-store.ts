import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";

import {
  AsinSchema,
  DateTimeSchema,
  ManualAlexaVocNormalizedRecordSchema,
  Sha256Schema,
} from "../../shared/agent-contracts";
import type { ManualAlexaVocRevision } from "../db/manual-alexa-voc-repository";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";

const DecimalStringSchema = z.string().regex(/^[1-9]\d*$/);
const OwnerIdSchema = z.string().trim().min(1).max(200);
const MANIFEST_SCHEMA_VERSION = "manual-voc-owner-manifest/v1" as const;
const PROJECTION_SCHEMA_VERSION = "manual-voc-projection/v1" as const;
const INVALIDATION_SCHEMA_VERSION =
  "manual-voc-projection-invalidation/v1" as const;

const ProjectionManifestRecordSchema = z.strictObject({
  revision: DecimalStringSchema,
  contentHash: Sha256Schema,
  capturedAt: DateTimeSchema,
  generation: DecimalStringSchema,
});

const ProjectionManifestSchema = z.strictObject({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  ownerOrganizationId: OwnerIdSchema,
  marketplace: z.literal("US"),
  artifactGeneration: DecimalStringSchema,
  sourceHeadsHash: Sha256Schema,
  generatedAt: DateTimeSchema,
  records: z.record(AsinSchema, ProjectionManifestRecordSchema),
});

export type ManualAlexaVocProjectionManifest = z.infer<
  typeof ProjectionManifestSchema
>;

const ProjectionRecordSchema = z.strictObject({
  revision: DecimalStringSchema,
  contentHash: Sha256Schema,
  capturedAt: DateTimeSchema,
  normalizedSchemaVersion: z.literal("alexa-voc-record/v2"),
  parserVersion: z.literal("deterministic-alexa-parser/v3"),
  normalizedRecord: ManualAlexaVocNormalizedRecordSchema,
});

const ProjectionArtifactSchema = z.strictObject({
  schemaVersion: z.literal(PROJECTION_SCHEMA_VERSION),
  ownerOrganizationId: OwnerIdSchema,
  marketplace: z.literal("US"),
  artifactGeneration: DecimalStringSchema,
  sourceHeadsHash: Sha256Schema,
  generatedAt: DateTimeSchema,
  records: z.record(AsinSchema, ProjectionRecordSchema),
  invalidation: z.strictObject({
    schemaVersion: z.literal(INVALIDATION_SCHEMA_VERSION),
    scope: z.strictObject({
      organizationId: OwnerIdSchema,
      marketplace: z.literal("US"),
    }),
    epoch: DecimalStringSchema,
    changedAsins: z.array(AsinSchema).min(1),
    revisions: z.record(AsinSchema, DecimalStringSchema),
  }),
});

type ProjectionArtifact = z.infer<typeof ProjectionArtifactSchema>;

const RevisionSchema = z.strictObject({
  organizationId: OwnerIdSchema,
  marketplace: z.literal("US"),
  asin: AsinSchema,
  revision: DecimalStringSchema,
  contentHash: Sha256Schema,
  capturedAt: DateTimeSchema,
  normalizedRecord: ManualAlexaVocNormalizedRecordSchema,
  normalizedSchemaVersion: z.literal("alexa-voc-record/v2"),
  parserVersion: z.literal("deterministic-alexa-parser/v3"),
});

export type ManualAlexaVocProjectionPublishResult = Readonly<{
  artifactGeneration: string;
  changed: boolean;
}>;

export class ManualAlexaVocProjectionStoreError extends Error {
  readonly code: "PROJECTION_CONFLICT" | "PROJECTION_IO" | "PROJECTION_BUSY";

  constructor(
    code: ManualAlexaVocProjectionStoreError["code"],
    options?: ErrorOptions,
  ) {
    super(
      code === "PROJECTION_CONFLICT"
        ? "Manual Alexa VOC projection state conflicts with the database head"
        : code === "PROJECTION_BUSY"
          ? "Manual Alexa VOC projection is busy"
          : "Manual Alexa VOC projection storage is unavailable",
      options,
    );
    this.name = "ManualAlexaVocProjectionStoreError";
    this.code = code;
  }
}

export class ManualAlexaVocProjectionStore {
  readonly #root: string;
  readonly #projectionPathKey: string;
  readonly #lockWaitMs: number;
  readonly #staleLockMs: number;

  constructor(options: Readonly<{
    root: string;
    projectionPathKey: string;
    buildRoot?: string;
    lockWaitMs?: number;
    staleLockMs?: number;
  }>) {
    const root = resolve(options.root);
    const buildRoot = resolve(options.buildRoot ?? process.cwd());
    if (containsPath(buildRoot, root) || containsPath(root, buildRoot)) {
      throw new TypeError(
        "Manual Alexa VOC projection root must be outside the application build tree",
      );
    }
    if (
      options.projectionPathKey.length < 32 ||
      options.projectionPathKey.length > 512
    ) {
      throw new TypeError("Manual Alexa VOC projection path key is invalid");
    }
    this.#root = root;
    this.#projectionPathKey = options.projectionPathKey;
    this.#lockWaitMs = boundedPositiveInteger(options.lockWaitMs ?? 5_000);
    this.#staleLockMs = boundedPositiveInteger(options.staleLockMs ?? 120_000);
  }

  async publish(
    input: ManualAlexaVocRevision,
  ): Promise<ManualAlexaVocProjectionPublishResult> {
    const record = parseRevision(input);
    const directory = this.#projectionDirectory(record.organizationId);
    try {
      return await withProjectionLock({
        directory,
        lockWaitMs: this.#lockWaitMs,
        staleLockMs: this.#staleLockMs,
        operation: async () => this.#publishLocked(directory, record),
      });
    } catch (error) {
      if (error instanceof ManualAlexaVocProjectionStoreError) throw error;
      throw new ManualAlexaVocProjectionStoreError("PROJECTION_IO", {
        cause: error,
      });
    }
  }

  async #publishLocked(
    directory: string,
    input: z.infer<typeof RevisionSchema>,
  ): Promise<ManualAlexaVocProjectionPublishResult> {
    const current = await readCurrentProjection(directory);
    if (current) {
      assertProjectionOwner(current.manifest, input);
      const existing = current.artifact.records[input.asin];
      if (existing) {
        const order = BigInt(input.revision) - BigInt(existing.revision);
        if (order < BigInt(0)) {
          return Object.freeze({
            artifactGeneration: current.manifest.artifactGeneration,
            changed: false,
          });
        }
        if (order === BigInt(0)) {
          if (!sameProjectionRecord(existing, input)) {
            throw new ManualAlexaVocProjectionStoreError(
              "PROJECTION_CONFLICT",
            );
          }
          return Object.freeze({
            artifactGeneration: current.manifest.artifactGeneration,
            changed: false,
          });
        }
        if (input.capturedAt < existing.capturedAt) {
          throw new ManualAlexaVocProjectionStoreError("PROJECTION_CONFLICT");
        }
      }
    }

    const artifactGeneration = current
      ? incrementDecimal(current.manifest.artifactGeneration)
      : "1";
    const records = sortedRecord({
      ...(current?.artifact.records ?? {}),
      [input.asin]: projectionRecord(input),
    });
    const manifestRecords = sortedRecord(Object.fromEntries(
      Object.entries(records).map(([asin, record]) => [asin, {
        revision: record.revision,
        contentHash: record.contentHash,
        capturedAt: record.capturedAt,
        generation: artifactGeneration,
      }]),
    ));
    const sourceHeadsHash = canonicalJsonSha256(manifestRecords);
    const generatedAt = Object.values(records)
      .map(record => record.capturedAt)
      .sort()
      .at(-1)!;
    const manifest = ProjectionManifestSchema.parse({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      ownerOrganizationId: input.organizationId,
      marketplace: input.marketplace,
      artifactGeneration,
      sourceHeadsHash,
      generatedAt,
      records: manifestRecords,
    });
    const artifact = ProjectionArtifactSchema.parse({
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      ownerOrganizationId: input.organizationId,
      marketplace: input.marketplace,
      artifactGeneration,
      sourceHeadsHash,
      generatedAt,
      records,
      invalidation: {
        schemaVersion: INVALIDATION_SCHEMA_VERSION,
        scope: {
          organizationId: input.organizationId,
          marketplace: input.marketplace,
        },
        epoch: artifactGeneration,
        changedAsins: [input.asin],
        revisions: sortedRecord(Object.fromEntries(
          Object.entries(records).map(([asin, record]) => [
            asin,
            record.revision,
          ]),
        )),
      },
    });
    const artifactPath = join(
      directory,
      `generation-${artifactGeneration}.json`,
    );
    await writeImmutableJson(artifactPath, artifact);
    await writeReplaceableJson(join(directory, "manifest.json"), manifest);
    return Object.freeze({ artifactGeneration, changed: true });
  }

  #projectionDirectory(organizationId: string) {
    const ownerPartition = createHmac("sha256", this.#projectionPathKey)
      .update(organizationId)
      .digest("base64url");
    return join(this.#root, ownerPartition, "US");
  }
}

async function readCurrentProjection(directory: string): Promise<Readonly<{
  manifest: ManualAlexaVocProjectionManifest;
  artifact: ProjectionArtifact;
}> | null> {
  let rawManifest: string;
  try {
    rawManifest = await readFile(join(directory, "manifest.json"), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
  let manifest: ManualAlexaVocProjectionManifest;
  try {
    manifest = ProjectionManifestSchema.parse(JSON.parse(rawManifest));
  } catch (error) {
    throw new ManualAlexaVocProjectionStoreError("PROJECTION_CONFLICT", {
      cause: error,
    });
  }
  let artifact: ProjectionArtifact;
  try {
    artifact = ProjectionArtifactSchema.parse(JSON.parse(await readFile(
      join(directory, `generation-${manifest.artifactGeneration}.json`),
      "utf8",
    )));
  } catch (error) {
    throw new ManualAlexaVocProjectionStoreError("PROJECTION_CONFLICT", {
      cause: error,
    });
  }
  if (
    artifact.ownerOrganizationId !== manifest.ownerOrganizationId ||
    artifact.marketplace !== manifest.marketplace ||
    artifact.artifactGeneration !== manifest.artifactGeneration ||
    artifact.sourceHeadsHash !== manifest.sourceHeadsHash ||
    canonicalJsonSha256(manifest.records) !== manifest.sourceHeadsHash ||
    artifact.invalidation.scope.organizationId !== manifest.ownerOrganizationId ||
    artifact.invalidation.scope.marketplace !== manifest.marketplace ||
    artifact.invalidation.epoch !== manifest.artifactGeneration
  ) {
    throw new ManualAlexaVocProjectionStoreError("PROJECTION_CONFLICT");
  }
  const artifactAsins = Object.keys(artifact.records).sort();
  const manifestAsins = Object.keys(manifest.records).sort();
  if (
    JSON.stringify(artifactAsins) !== JSON.stringify(manifestAsins) ||
    artifactAsins.some(asin => {
      const projected = artifact.records[asin]!;
      const metadata = manifest.records[asin]!;
      return projected.revision !== metadata.revision ||
        projected.contentHash !== metadata.contentHash ||
        projected.capturedAt !== metadata.capturedAt ||
        metadata.generation !== manifest.artifactGeneration ||
        artifact.invalidation.revisions[asin] !== projected.revision;
    })
  ) {
    throw new ManualAlexaVocProjectionStoreError("PROJECTION_CONFLICT");
  }
  return Object.freeze({ manifest, artifact });
}

function assertProjectionOwner(
  manifest: ManualAlexaVocProjectionManifest,
  input: z.infer<typeof RevisionSchema>,
) {
  if (
    manifest.ownerOrganizationId !== input.organizationId ||
    manifest.marketplace !== input.marketplace
  ) {
    throw new ManualAlexaVocProjectionStoreError("PROJECTION_CONFLICT");
  }
}

function parseRevision(input: ManualAlexaVocRevision) {
  try {
    return RevisionSchema.parse(input);
  } catch (error) {
    throw new ManualAlexaVocProjectionStoreError("PROJECTION_CONFLICT", {
      cause: error,
    });
  }
}

function projectionRecord(input: z.infer<typeof RevisionSchema>) {
  return Object.freeze({
    revision: input.revision,
    contentHash: input.contentHash,
    capturedAt: input.capturedAt,
    normalizedSchemaVersion: input.normalizedSchemaVersion,
    parserVersion: input.parserVersion,
    normalizedRecord: input.normalizedRecord,
  });
}

function sameProjectionRecord(
  existing: z.infer<typeof ProjectionRecordSchema>,
  incoming: z.infer<typeof RevisionSchema>,
) {
  return existing.contentHash === incoming.contentHash &&
    existing.capturedAt === incoming.capturedAt &&
    existing.normalizedSchemaVersion === incoming.normalizedSchemaVersion &&
    existing.parserVersion === incoming.parserVersion &&
    canonicalJsonSha256(existing.normalizedRecord) ===
      canonicalJsonSha256(incoming.normalizedRecord);
}

async function withProjectionLock<T>(input: Readonly<{
  directory: string;
  lockWaitMs: number;
  staleLockMs: number;
  operation: () => Promise<T>;
}>): Promise<T> {
  await mkdir(input.directory, { recursive: true });
  const lockPath = join(input.directory, ".publication.lock");
  const deadline = Date.now() + input.lockWaitMs;
  let acquired = false;
  while (!acquired) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      acquired = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const metadata = await stat(lockPath).catch(() => null);
      if (metadata && Date.now() - metadata.mtimeMs >= input.staleLockMs) {
        await unlink(lockPath).catch(error => {
          if (!isFileNotFound(error)) throw error;
        });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ManualAlexaVocProjectionStoreError("PROJECTION_BUSY");
      }
      await new Promise(resolveTimer => setTimeout(resolveTimer, 10));
    }
  }
  try {
    return await input.operation();
  } finally {
    await unlink(lockPath).catch(error => {
      if (!isFileNotFound(error)) throw error;
    });
    await fsyncDirectory(input.directory);
  }
}

async function writeImmutableJson(path: string, value: unknown) {
  const serialized = serializeJson(value);
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== serialized) {
      throw new ManualAlexaVocProjectionStoreError("PROJECTION_CONFLICT");
    }
    return;
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
  await writeTemporaryAndRename(path, serialized);
}

async function writeReplaceableJson(path: string, value: unknown) {
  await writeTemporaryAndRename(path, serializeJson(value));
}

async function writeTemporaryAndRename(path: string, serialized: string) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await fsyncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function fsyncDirectory(directory: string) {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function incrementDecimal(value: string) {
  const incremented = BigInt(value) + BigInt(1);
  if (incremented > BigInt("9223372036854775807")) {
    throw new ManualAlexaVocProjectionStoreError("PROJECTION_CONFLICT");
  }
  return incremented.toString();
}

function sortedRecord<T>(input: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function serializeJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function containsPath(parent: string, candidate: string) {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function boundedPositiveInteger(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 600_000) {
    throw new TypeError("Manual Alexa VOC projection lock configuration is invalid");
  }
  return value;
}

function isFileNotFound(error: unknown) {
  return Boolean(
    error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT",
  );
}

function isAlreadyExists(error: unknown) {
  return Boolean(
    error && typeof error === "object" && Reflect.get(error, "code") === "EEXIST",
  );
}

function isUnsupportedDirectorySync(error: unknown) {
  const code = error && typeof error === "object"
    ? Reflect.get(error, "code")
    : null;
  return code === "EINVAL" || code === "EISDIR" || code === "EPERM" ||
    code === "EACCES" || code === "ENOTSUP";
}
