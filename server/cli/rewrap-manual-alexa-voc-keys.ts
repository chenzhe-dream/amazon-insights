import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import { loadAgentStorageConfig } from "../config";
import type {
  ManualAlexaVocRawEnvelopeRecord,
  ManualAlexaVocRepository,
} from "../db/manual-alexa-voc-repository";
import { openRuntimeAgentRepository } from "../db/open-runtime-repository";
import {
  createManualAlexaVocCipher,
  type ManualAlexaVocCipher,
  type ManualAlexaVocEncryptedRaw,
} from "../security/manual-alexa-voc-cipher";

type RewrapRepository = Readonly<{
  manualAlexaVoc: ManualAlexaVocRepository;
  transaction<Result>(operation: () => Promise<Result>): Promise<Result>;
}>;

export async function rewrapManualAlexaVocKeys(input: Readonly<{
  repository: RewrapRepository;
  cipher: ManualAlexaVocCipher;
  organizationId: string;
  actorUserId: string;
  occurredAt: string;
  batchSize?: number;
}>): Promise<Readonly<{ scanned: number; rewrapped: number }>> {
  const organizationId = boundedIdentifier(input.organizationId);
  const actorUserId = boundedIdentifier(input.actorUserId);
  const batchSize = positiveInteger(input.batchSize ?? 100);
  const occurredAt = new Date(input.occurredAt).toISOString();
  let scanned = 0;
  let rewrapped = 0;

  while (true) {
    const records = await input.repository.manualAlexaVoc
      .listRawEnvelopesForRewrap({
        organizationId,
        activeKeyId: input.cipher.activeKeyId,
        limit: batchSize,
      });
    if (records.length === 0) break;
    scanned += records.length;
    for (const record of records) {
      try {
        const updated = input.cipher.rewrap({ envelope: record.raw });
        if (!isRewrapOnly(record, updated, input.cipher.activeKeyId)) {
          throw new Error("invalid rewrap result");
        }
        const changed = await input.repository.transaction(() =>
          input.repository.manualAlexaVoc.rewrapRawEnvelope({
            record,
            rewrapped: updated,
            actorUserId,
            occurredAt,
          }));
        if (changed) rewrapped += 1;
      } catch {
        await recordFailedRewrap({
          repository: input.repository,
          organizationId,
          actorUserId,
          occurredAt,
          record,
        });
        throw new Error("Manual Alexa VOC key rewrap failed");
      }
    }
  }

  return Object.freeze({ scanned, rewrapped });
}

async function recordFailedRewrap(input: Readonly<{
  repository: RewrapRepository;
  organizationId: string;
  actorUserId: string;
  occurredAt: string;
  record: ManualAlexaVocRawEnvelopeRecord;
}>): Promise<void> {
  try {
    await input.repository.transaction(() =>
      input.repository.manualAlexaVoc.recordRawAccess({
        id: randomUUID(),
        organizationId: input.organizationId,
        marketplace: input.record.marketplace,
        asin: input.record.asin,
        revision: input.record.revision,
        actorUserId: input.actorUserId,
        purpose: "key-rewrap",
        occurredAt: input.occurredAt,
        result: "failed",
      }));
  } catch {
    // The CLI still fails closed with one redacted error if audit persistence fails.
  }
}

function isRewrapOnly(
  record: ManualAlexaVocRawEnvelopeRecord,
  updated: ManualAlexaVocEncryptedRaw,
  activeKeyId: string,
): boolean {
  return (
    updated.keyId === activeKeyId &&
    record.raw.keyId !== updated.keyId &&
    record.raw.algVersion === updated.algVersion &&
    record.raw.wrappedDek.byteLength === updated.wrappedDek.byteLength &&
    isDeepStrictEqual(record.raw.nonce, updated.nonce) &&
    isDeepStrictEqual(record.raw.ciphertext, updated.ciphertext) &&
    isDeepStrictEqual(record.raw.tag, updated.tag) &&
    record.raw.aadSha256 === updated.aadSha256 &&
    record.raw.plaintextBytes === updated.plaintextBytes &&
    record.raw.plaintextSha256 === updated.plaintextSha256
  );
}

function parseArguments(argv: readonly string[]) {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--organization-id",
    "--actor-user-id",
    "--batch-size",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !allowed.has(name) || !value || value.startsWith("--")) {
      throw new Error("Invalid arguments");
    }
    if (values.has(name)) throw new Error("Invalid arguments");
    values.set(name, value);
  }
  const organizationId = values.get("--organization-id");
  const actorUserId = values.get("--actor-user-id");
  if (!organizationId || !actorUserId) throw new Error("Invalid arguments");
  const batch = values.get("--batch-size");
  return Object.freeze({
    organizationId: boundedIdentifier(organizationId),
    actorUserId: boundedIdentifier(actorUserId),
    batchSize: batch === undefined ? 100 : positiveInteger(Number(batch)),
  });
}

export async function runManualAlexaVocKeyRewrapCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  let repository: Awaited<ReturnType<typeof openRuntimeAgentRepository>> | null =
    null;
  try {
    const options = parseArguments(argv);
    repository = await openRuntimeAgentRepository(loadAgentStorageConfig());
    const result = await rewrapManualAlexaVocKeys({
      repository,
      cipher: createManualAlexaVocCipher(),
      ...options,
      occurredAt: new Date().toISOString(),
    });
    process.stdout.write(`${JSON.stringify({
      status: "completed",
      scanned: result.scanned,
      rewrapped: result.rewrapped,
    })}\n`);
    return 0;
  } catch {
    process.stderr.write("Manual Alexa VOC key rewrap failed\n");
    return 1;
  } finally {
    await Promise.resolve(repository?.close());
  }
}

function boundedIdentifier(value: string): string {
  if (!value || value.trim() !== value || value.length > 200 || value === "*") {
    throw new Error("Invalid arguments");
  }
  return value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Invalid arguments");
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runManualAlexaVocKeyRewrapCli();
}
