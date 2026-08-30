import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ManualAlexaVocNormalizedRecordSchema } from "../../shared/agent-contracts";
import {
  LEGACY_MANUAL_VOC_OWNER_MANIFEST_SCHEMA_VERSION,
  LegacyManualVocOwnerManifestSchema,
  loadStaticLegacyManualAlexaVocData,
  type LegacyManualAlexaVocData,
  type LegacyManualVocOwnerManifest,
} from "../data/legacy-manual-alexa-voc-source";
import {
  loadAgentStorageConfig,
  type AgentStorageConfig,
} from "../config";
import {
  openRuntimeAgentRepository,
  type OpenRuntimeAgentRepositoryResult,
} from "../db/open-runtime-repository";
import type { UserRecord } from "../db/repository";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";

export type LegacyManualAlexaVocBindingOptions = Readonly<{
  actorUserId: string;
  marketplace: "US";
  manifestPath: string;
  auditDirectory: string;
}>;

export type LegacyManualAlexaVocBindingDependencies = Readonly<{
  defaultOrganizationId?: string;
  findUserById: (id: string) => Promise<UserRecord | null>;
  loadLegacyData?: () => Promise<LegacyManualAlexaVocData>;
  now?: () => string;
  createId?: () => string;
}>;

const ALLOWED_ARGUMENTS = new Set([
  "--actor-user-id",
  "--marketplace",
  "--manifest-path",
  "--audit-directory",
]);

export function parseLegacyManualAlexaVocBindingArgv(
  argv: readonly string[],
): LegacyManualAlexaVocBindingOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name || !ALLOWED_ARGUMENTS.has(name)) {
      throw new Error("Unknown argument");
    }
    if (values.has(name)) throw new Error("Duplicate argument");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("Missing required argument value");
    }
    values.set(name, value);
  }
  const actorUserId = values.get("--actor-user-id")?.trim();
  const marketplace = values.get("--marketplace")?.trim().toUpperCase();
  const manifestPath = values.get("--manifest-path")?.trim();
  const auditDirectory = values.get("--audit-directory")?.trim();
  if (!actorUserId || !marketplace || !manifestPath || !auditDirectory) {
    throw new Error("Missing required binding option");
  }
  if (marketplace !== "US") throw new Error("Legacy marketplace is invalid");
  return { actorUserId, marketplace, manifestPath, auditDirectory };
}

export async function bindLegacyManualAlexaVoc(
  options: LegacyManualAlexaVocBindingOptions,
  dependencies: LegacyManualAlexaVocBindingDependencies,
): Promise<Readonly<{
  created: boolean;
  manifest: LegacyManualVocOwnerManifest;
}>> {
  const organizationId = validateDefaultOrganization(
    dependencies.defaultOrganizationId ??
      process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID,
  );
  if (options.marketplace !== "US") {
    throw new Error("Legacy marketplace does not match the supported marketplace");
  }
  const actorUserId = options.actorUserId.trim();
  if (!actorUserId || actorUserId !== options.actorUserId) {
    throw new Error("Binding actor is invalid");
  }
  const actor = await dependencies.findUserById(actorUserId);
  if (!actor) throw new Error("Binding actor does not exist");
  if (actor.status !== "active") throw new Error("Binding actor must be active");
  if (actor.organizationId !== organizationId) {
    throw new Error("Binding actor organization does not match the default organization");
  }

  const loadLegacyData =
    dependencies.loadLegacyData ?? loadStaticLegacyManualAlexaVocData;
  const existing = await readExistingManifest(options.manifestPath);
  if (existing) {
    const legacy = await loadLegacyData();
    if (legacy.marketplace !== options.marketplace) {
      throw new Error("Legacy marketplace does not match the binding marketplace");
    }
    const requested = buildBindingManifest({
      organizationId,
      marketplace: options.marketplace,
      generatedAt: existing.generatedAt,
      bindingAuditId: existing.bindingAuditId,
      bindingActorUserId: actor.id,
      legacy,
    });
    assertSameBinding(existing, requested);
    await ensureBindingAudit(options.auditDirectory, existing);
    return Object.freeze({ created: false, manifest: existing });
  }

  const legacy = await loadLegacyData();
  if (legacy.marketplace !== options.marketplace) {
    throw new Error("Legacy marketplace does not match the binding marketplace");
  }

  const now = dependencies.now ?? (() => new Date().toISOString());
  const createId = dependencies.createId ?? randomUUID;
  const manifest = buildBindingManifest({
    organizationId,
    marketplace: options.marketplace,
    generatedAt: new Date(now()).toISOString(),
    bindingAuditId: createId(),
    bindingActorUserId: actor.id,
    legacy,
  });
  try {
    await writeJsonAtomicExclusive(options.manifestPath, manifest);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const winner = await readExistingManifest(options.manifestPath);
    if (!winner) throw error;
    assertSameBinding(winner, manifest);
    await ensureBindingAudit(options.auditDirectory, winner);
    return Object.freeze({ created: false, manifest: winner });
  }
  await ensureBindingAudit(options.auditDirectory, manifest);
  return Object.freeze({ created: true, manifest });
}

export async function runLegacyManualAlexaVocBindingCli(
  argv: readonly string[] = process.argv.slice(2),
  io: Readonly<{
    stdout: NodeJS.WriteStream;
    stderr: NodeJS.WriteStream;
  }> = { stdout: process.stdout, stderr: process.stderr },
  openRepository: (
    config: AgentStorageConfig,
  ) => OpenRuntimeAgentRepositoryResult | Promise<OpenRuntimeAgentRepositoryResult> =
    openRuntimeAgentRepository,
): Promise<number> {
  let repository: OpenRuntimeAgentRepositoryResult | null = null;
  try {
    const options = parseLegacyManualAlexaVocBindingArgv(argv);
    repository = await openRepository(loadAgentStorageConfig());
    const result = await bindLegacyManualAlexaVoc(options, {
      defaultOrganizationId: process.env.LEGACY_VOC_DEFAULT_ORGANIZATION_ID,
      findUserById: id => repository!.findUserById(id),
    });
    io.stdout.write(`${JSON.stringify({
      status: result.created ? "bound" : "already-bound",
      marketplace: result.manifest.marketplace,
      generation: result.manifest.artifactGeneration,
    })}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`Legacy Manual Alexa VOC binding failed: ${safeMessage(error)}\n`);
    return 1;
  } finally {
    await Promise.resolve(repository?.close());
  }
}

function buildBindingManifest(input: Readonly<{
  organizationId: string;
  marketplace: "US";
  generatedAt: string;
  bindingAuditId: string;
  bindingActorUserId: string;
  legacy: LegacyManualAlexaVocData;
}>): LegacyManualVocOwnerManifest {
  const artifactGeneration = input.legacy.artifactGeneration;
  const records = Object.fromEntries(
    Object.entries(input.legacy.data).flatMap(([asin, raw]) => {
      if (!raw || typeof raw !== "object") return [];
      if (Reflect.get(raw, "captureStatus") !== "dialog") return [];
      const normalized = ManualAlexaVocNormalizedRecordSchema.safeParse({
        ...raw,
        asin,
      });
      if (!normalized.success) return [];
      return [[asin, {
        revision: "1",
        contentHash: canonicalJsonSha256(normalized.data),
        capturedAt: input.legacy.recordCapturedAt?.[asin] ?? input.legacy.capturedAt,
        generation: artifactGeneration,
      }]];
    }),
  );
  return LegacyManualVocOwnerManifestSchema.parse({
    schemaVersion: LEGACY_MANUAL_VOC_OWNER_MANIFEST_SCHEMA_VERSION,
    ownerOrganizationId: input.organizationId,
    marketplace: input.marketplace,
    artifactGeneration,
    sourceHeadsHash: canonicalJsonSha256(records),
    generatedAt: input.generatedAt,
    bindingAuditId: input.bindingAuditId,
    bindingActorUserId: input.bindingActorUserId,
    records,
  });
}

async function readExistingManifest(
  manifestPath: string,
): Promise<LegacyManualVocOwnerManifest | null> {
  try {
    return LegacyManualVocOwnerManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

function assertSameBinding(
  existing: LegacyManualVocOwnerManifest,
  requested: LegacyManualVocOwnerManifest,
) {
  if (
    existing.ownerOrganizationId !== requested.ownerOrganizationId ||
    existing.marketplace !== requested.marketplace ||
    canonicalJsonSha256(existing.records) !== existing.sourceHeadsHash ||
    existing.sourceHeadsHash !== requested.sourceHeadsHash ||
    existing.artifactGeneration !== requested.artifactGeneration ||
    existing.bindingActorUserId !== requested.bindingActorUserId
  ) {
    throw new Error("Legacy Manual Alexa VOC is already bound to a different organization or artifact");
  }
}

async function ensureBindingAudit(
  auditDirectory: string,
  manifest: LegacyManualVocOwnerManifest,
) {
  const audit = {
    schemaVersion: "manual-voc-legacy-binding-audit/v1",
    id: manifest.bindingAuditId,
    action: "manual-alexa-voc.legacy-owner-bound",
    organizationId: manifest.ownerOrganizationId,
    actorUserId: manifest.bindingActorUserId,
    marketplace: manifest.marketplace,
    artifactGeneration: manifest.artifactGeneration,
    sourceHeadsHash: manifest.sourceHeadsHash,
    occurredAt: manifest.generatedAt,
  };
  const resolvedAuditDirectory = resolve(auditDirectory);
  const path = resolve(
    resolvedAuditDirectory,
    `${manifest.bindingAuditId}.json`,
  );
  if (dirname(path) !== resolvedAuditDirectory) {
    throw new Error("Legacy Manual Alexa VOC binding audit identity is invalid");
  }
  try {
    await writeJsonAtomicExclusive(path, audit);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (canonicalJsonSha256(existing) !== canonicalJsonSha256(audit)) {
      throw new Error("Legacy Manual Alexa VOC binding audit identity conflicts");
    }
  }
}

async function writeJsonAtomicExclusive(path: string, value: unknown) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function validateDefaultOrganization(value: string | undefined) {
  if (
    !value ||
    value === "*" ||
    value.trim() !== value ||
    value.length > 200
  ) {
    throw new Error("LEGACY_VOC_DEFAULT_ORGANIZATION_ID is not a valid default organization");
  }
  return value;
}

function isFileNotFound(error: unknown) {
  return Boolean(error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT");
}

function isAlreadyExists(error: unknown) {
  return Boolean(error && typeof error === "object" && Reflect.get(error, "code") === "EEXIST");
}

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message : "binding failed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runLegacyManualAlexaVocBindingCli();
}
