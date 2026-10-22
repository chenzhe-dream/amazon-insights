import type { ProjectMarketplace } from "../../shared/project-marketplaces";
import { randomUUID } from "node:crypto";

import { DateTimeSchema } from "../../shared/agent-contracts";
import type { RequestPrincipal } from "../auth/authorization";
import type {
  ManualAlexaVocRawAccessAuditEvent,
  ManualAlexaVocRepository,
} from "../db/manual-alexa-voc-repository";
import type { ManualAlexaVocCipher } from "../security/manual-alexa-voc-cipher";

const MINIMUM_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;

type ManualAlexaVocTransactionalRepository = Readonly<{
  manualAlexaVoc: ManualAlexaVocRepository;
  transaction<Result>(operation: () => Promise<Result>): Promise<Result>;
}>;

type RetentionTarget = Readonly<{
  organizationId: string;
  actorUserId: string;
}>;

export class ManualAlexaVocRawAccessError extends Error {
  readonly code = "MANUAL_ALEXA_VOC_RAW_ACCESS_FAILED";

  constructor() {
    super("Manual Alexa VOC raw access failed");
    this.name = "ManualAlexaVocRawAccessError";
  }
}

export class ManualAlexaVocRetentionService {
  readonly #repository: ManualAlexaVocTransactionalRepository;
  readonly #cipher: ManualAlexaVocCipher;
  readonly #policyByOrganization: Readonly<Record<string, number>>;
  readonly #batchSize: number;
  readonly #sweepTargets: readonly RetentionTarget[];
  readonly #pollIntervalMs: number;
  readonly #clock: () => Date;
  readonly #setInterval: (callback: () => void, ms: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;
  readonly #inFlight = new Set<Promise<unknown>>();
  #timer: unknown | null = null;
  #active = false;

  constructor(options: Readonly<{
    repository: ManualAlexaVocTransactionalRepository;
    cipher: ManualAlexaVocCipher;
    policyByOrganization?: Readonly<Record<string, number>>;
    batchSize?: number;
    sweepTargets?: readonly RetentionTarget[];
    pollIntervalMs?: number;
    clock?: () => Date;
    setInterval?: (callback: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
  }>) {
    this.#repository = options.repository;
    this.#cipher = options.cipher;
    this.#policyByOrganization = validatePolicies(
      options.policyByOrganization ?? {},
    );
    this.#batchSize = positiveInteger(options.batchSize ?? 100, 1_000);
    this.#sweepTargets = Object.freeze(
      (options.sweepTargets ?? []).map(validateTarget),
    );
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DAY_MS,
      Number.MAX_SAFE_INTEGER,
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#setInterval = options.setInterval ?? setInterval;
    this.#clearInterval = options.clearInterval ??
      ((handle: unknown) => clearInterval(
        handle as ReturnType<typeof setInterval>,
      ));
  }

  clearExpired(input: Readonly<{
    organizationId: string;
    asOf: string;
    actorUserId: string;
  }>): Promise<number> {
    const organizationId = boundedIdentifier(input.organizationId);
    const actorUserId = boundedIdentifier(input.actorUserId);
    const asOf = normalizeDateTime(input.asOf);
    const retentionDays = this.#policyByOrganization[organizationId] ??
      MINIMUM_RETENTION_DAYS;
    const before = new Date(
      new Date(asOf).getTime() - retentionDays * DAY_MS,
    ).toISOString();
    return this.#repository.transaction(() =>
      this.#repository.manualAlexaVoc.clearExpiredRaw({
        organizationId,
        before,
        clearedAt: asOf,
        actorUserId,
        limit: this.#batchSize,
      }));
  }

  async decryptRaw(input: Readonly<{
    principal: RequestPrincipal;
    marketplace: ProjectMarketplace;
    asin: string;
    revision: string;
    purpose: "decrypt" | "reparse" | "export";
  }>): Promise<string> {
    const principal = input.principal;
    if (principal.kind !== "user") throw new ManualAlexaVocRawAccessError();
    const scope = {
      organizationId: principal.organizationId,
      marketplace: input.marketplace,
      asin: input.asin,
      revision: input.revision,
    } as const;
    if (principal.role !== "admin") {
      try {
        await this.#recordRawAccess({
          ...scope,
          actorUserId: principal.userId,
          purpose: input.purpose,
          result: "denied",
        });
      } catch {
        // Access remains denied if its metadata-only audit cannot be persisted.
      }
      throw new ManualAlexaVocRawAccessError();
    }

    try {
      const outcome = await this.#repository.transaction(async () => {
        const record = await this.#repository.manualAlexaVoc.readRawEnvelope(scope);
        if (!record) {
          await this.#repository.manualAlexaVoc.recordRawAccess({
            id: randomUUID(),
            ...scope,
            actorUserId: principal.userId,
            purpose: input.purpose,
            occurredAt: this.#now(),
            result: "failed",
          });
          return Object.freeze({ ok: false as const });
        }
        try {
          const plaintext = this.#cipher.decrypt({
            identity: {
              organizationId: record.organizationId,
              marketplace: record.marketplace,
              asin: record.asin,
              revision: record.revision,
              normalizedSchemaVersion: record.normalizedSchemaVersion,
              parserVersion: record.parserVersion,
            },
            envelope: record.raw,
          });
          await this.#repository.manualAlexaVoc.recordRawAccess({
            id: randomUUID(),
            ...scope,
            actorUserId: principal.userId,
            purpose: input.purpose,
            occurredAt: this.#now(),
            result: "succeeded",
          });
          return Object.freeze({ ok: true as const, plaintext });
        } catch {
          await this.#repository.manualAlexaVoc.recordRawAccess({
            id: randomUUID(),
            ...scope,
            actorUserId: principal.userId,
            purpose: input.purpose,
            occurredAt: this.#now(),
            result: "failed",
          });
          return Object.freeze({ ok: false as const });
        }
      });
      if (!outcome.ok) throw new ManualAlexaVocRawAccessError();
      return outcome.plaintext;
    } catch {
      throw new ManualAlexaVocRawAccessError();
    }
  }

  async listAudit(input: Readonly<{
    principal: RequestPrincipal;
    limit: number;
  }>): Promise<readonly ManualAlexaVocRawAccessAuditEvent[]> {
    if (input.principal.kind !== "user" || input.principal.role !== "admin") {
      throw new ManualAlexaVocRawAccessError();
    }
    try {
      return await this.#repository.manualAlexaVoc.listRawAccessAudit({
        organizationId: input.principal.organizationId,
        requestedByUserId: input.principal.userId,
        limit: positiveInteger(input.limit, 1_000),
      });
    } catch {
      throw new ManualAlexaVocRawAccessError();
    }
  }

  async sweepOnce(asOf = this.#now()): Promise<number> {
    const results = await Promise.allSettled(this.#sweepTargets.map((target) =>
      this.clearExpired({ ...target, asOf })));
    return results.reduce(
      (total, result) => total +
        (result.status === "fulfilled" ? result.value : 0),
      0,
    );
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = this.#setInterval(
      () => this.#scheduleSweep(),
      this.#pollIntervalMs,
    );
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      this.#clearInterval(this.#timer);
      this.#timer = null;
    }
    await Promise.allSettled([...this.#inFlight]);
  }

  #recordRawAccess(input: Readonly<{
    organizationId: string;
    marketplace: ProjectMarketplace;
    asin: string;
    revision: string;
    actorUserId: string;
    purpose: "decrypt" | "reparse" | "export";
    result: "denied";
  }>): Promise<void> {
    return this.#repository.transaction(() =>
      this.#repository.manualAlexaVoc.recordRawAccess({
        id: randomUUID(),
        ...input,
        occurredAt: this.#now(),
      }));
  }

  #scheduleSweep(): void {
    if (this.#active) return;
    this.#active = true;
    const tracked = this.sweepOnce()
      .catch(() => undefined)
      .finally(() => {
        this.#active = false;
        this.#inFlight.delete(tracked);
      });
    this.#inFlight.add(tracked);
  }

  #now(): string {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) {
      throw new ManualAlexaVocRawAccessError();
    }
    return value.toISOString();
  }
}

function validatePolicies(
  policies: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const validated: Record<string, number> = {};
  for (const [organizationId, days] of Object.entries(policies)) {
    boundedIdentifier(organizationId);
    if (!Number.isSafeInteger(days) || days < MINIMUM_RETENTION_DAYS) {
      throw new TypeError("Manual Alexa VOC retention policy is invalid");
    }
    validated[organizationId] = days;
  }
  return Object.freeze(validated);
}

function validateTarget(target: RetentionTarget): RetentionTarget {
  return Object.freeze({
    organizationId: boundedIdentifier(target.organizationId),
    actorUserId: boundedIdentifier(target.actorUserId),
  });
}

function boundedIdentifier(value: string): string {
  if (!value || value.trim() !== value || value.length > 200 || value === "*") {
    throw new TypeError("Manual Alexa VOC retention identity is invalid");
  }
  return value;
}

function positiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError("Manual Alexa VOC retention configuration is invalid");
  }
  return value;
}

function normalizeDateTime(value: string): string {
  try {
    return new Date(DateTimeSchema.parse(value)).toISOString();
  } catch {
    throw new TypeError("Manual Alexa VOC retention timestamp is invalid");
  }
}
