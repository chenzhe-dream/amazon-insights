import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ResourceGovernor } from "../db/concurrency-control-repository";
import type { PostgresConcurrencyControlStore } from "../db/postgres/concurrency-control-store";
import type {
  ConcurrencyAdminResponse,
} from "../../shared/agent-contracts";

type Profile = ConcurrencyAdminResponse["policy"]["profile"];
type ConnectorId = "sellerSprite" | "sif" | "sorftime";

export interface ConcurrencyAdminService {
  read(input: { organizationId: string }): Promise<ConcurrencyAdminResponse>;
  setPolicy(input: {
    organizationId: string;
    actorUserId: string;
    profile: Profile;
  }): Promise<ConcurrencyAdminResponse>;
  setManualTotal(input: {
    organizationId: string;
    actorUserId: string;
    total: number | null;
  }): Promise<ConcurrencyAdminResponse>;
  refreshQuota(input: {
    organizationId: string;
    actorUserId: string | null;
  }): Promise<ConcurrencyAdminResponse>;
  setPause(input: {
    organizationId: string;
    actorUserId: string;
    resource: "sellerSprite";
    paused: boolean;
  }): Promise<ConcurrencyAdminResponse>;
  resetCircuit(input: {
    organizationId: string;
    actorUserId: string;
    connectorId: ConnectorId;
  }): Promise<ConcurrencyAdminResponse>;
}

type Store = Pick<
  PostgresConcurrencyControlStore,
  | "readConcurrencyAdminState"
  | "setConcurrencyProfile"
  | "setSellerSpriteManualTotal"
  | "recordSellerSpriteQuotaSnapshot"
  | "setSellerSpriteManualPause"
  | "resetConnectorCircuit"
>;

type VisitsFetch = (url: string, init: RequestInit) => Promise<Response>;

const visitsResponseSchema = z.strictObject({
  remaining: z.number().int().nonnegative().optional(),
  used: z.number().int().nonnegative().optional(),
  total: z.number().int().positive().optional(),
  code: z.literal("ERROR_VISIT_MAX").optional(),
});

export class SellerSpriteQuotaService implements ConcurrencyAdminService {
  readonly #store: Store;
  readonly #governor: ResourceGovernor;
  readonly #visitsUrl: string | null;
  readonly #secretKey: string | null;
  readonly #timeoutMs: number;
  readonly #fetchVisits: VisitsFetch;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(options: {
    store: Store;
    governor: ResourceGovernor;
    visitsUrl: string | null;
    secretKey: string | null;
    timeoutMs?: number;
    fetchVisits?: VisitsFetch;
    clock?: () => Date;
    createId?: () => string;
  }) {
    this.#store = options.store;
    this.#governor = options.governor;
    this.#visitsUrl = options.visitsUrl === null ? null : validateVisitsUrl(options.visitsUrl);
    this.#secretKey = options.secretKey?.trim() || null;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetchVisits = options.fetchVisits ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  get refreshConfigured(): boolean {
    return this.#visitsUrl !== null && this.#secretKey !== null;
  }

  async read(input: { organizationId: string }): Promise<ConcurrencyAdminResponse> {
    return this.#store.readConcurrencyAdminState({
      organizationId: input.organizationId,
      now: this.#clock().toISOString(),
    });
  }

  async setPolicy(input: {
    organizationId: string;
    actorUserId: string;
    profile: Profile;
  }): Promise<ConcurrencyAdminResponse> {
    await this.#store.setConcurrencyProfile({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      profile: input.profile,
      changedAt: this.#clock().toISOString(),
      auditEventId: this.#createId(),
    });
    return this.read({ organizationId: input.organizationId });
  }

  async setManualTotal(input: {
    organizationId: string;
    actorUserId: string;
    total: number | null;
  }): Promise<ConcurrencyAdminResponse> {
    await this.#store.setSellerSpriteManualTotal({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      total: input.total,
      updatedAt: this.#clock().toISOString(),
      auditEventId: this.#createId(),
    });
    return this.read({ organizationId: input.organizationId });
  }

  async refreshQuota(input: {
    organizationId: string;
    actorUserId: string | null;
  }): Promise<ConcurrencyAdminResponse> {
    const checkedAt = this.#clock().toISOString();
    const snapshot = await this.#safeFetchVisits(input.organizationId);
    await this.#store.recordSellerSpriteQuotaSnapshot({
      id: this.#createId(),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      remaining: snapshot.remaining,
      used: snapshot.used,
      providerTotal: snapshot.providerTotal,
      source: snapshot.source,
      status: snapshot.status,
      errorCode: snapshot.errorCode,
      checkedAt,
      quotaAuditEventId: this.#createId(),
      policyAuditEventId: this.#createId(),
    });
    return this.read({ organizationId: input.organizationId });
  }

  async setPause(input: {
    organizationId: string;
    actorUserId: string;
    resource: "sellerSprite";
    paused: boolean;
  }): Promise<ConcurrencyAdminResponse> {
    await this.#store.setSellerSpriteManualPause({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      paused: input.paused,
      updatedAt: this.#clock().toISOString(),
      auditEventId: this.#createId(),
    });
    return this.read({ organizationId: input.organizationId });
  }

  async resetCircuit(input: {
    organizationId: string;
    actorUserId: string;
    connectorId: ConnectorId;
  }): Promise<ConcurrencyAdminResponse> {
    await this.#store.resetConnectorCircuit({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      connectorId: input.connectorId,
      updatedAt: this.#clock().toISOString(),
      auditEventId: this.#createId(),
    });
    return this.read({ organizationId: input.organizationId });
  }

  async #safeFetchVisits(organizationId: string): Promise<{
    remaining: number | null;
    used: number | null;
    providerTotal: number | null;
    source: ConcurrencyAdminResponse["sellerSpriteQuota"]["source"];
    status: ConcurrencyAdminResponse["sellerSpriteQuota"]["status"];
    errorCode: "ERROR_VISIT_MAX" | "MALFORMED_RESPONSE" | "UPSTREAM_UNAVAILABLE" | "REQUEST_TIMEOUT" | null;
  }> {
    if (!this.#visitsUrl || !this.#secretKey) {
      throw new SellerSpriteQuotaRefreshConfigurationError();
    }
    try {
      const response = await this.#governor.run({
        organizationId,
        resource: "sellerSprite",
        jobId: "seller-sprite-quota-refresh",
        attemptKind: "quota-refresh",
        maxWaitMs: 1_000,
        operation: () => this.#fetchVisitsWithTimeout(this.#visitsUrl!, this.#secretKey!),
      });
      if (!response.ok) {
        return safeErrorSnapshot("UPSTREAM_UNAVAILABLE");
      }
      const parsed = visitsResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        return safeErrorSnapshot("MALFORMED_RESPONSE");
      }
      if (parsed.data.code === "ERROR_VISIT_MAX") {
        return {
          remaining: 0,
          used: parsed.data.used ?? null,
          providerTotal: parsed.data.total ?? null,
          source: "provider",
          status: "paused",
          errorCode: "ERROR_VISIT_MAX",
        };
      }
      const remaining = parsed.data.remaining ?? null;
      const total = parsed.data.total ?? null;
      return {
        remaining,
        used: parsed.data.used ?? null,
        providerTotal: total,
        source: "provider",
        status: classifyQuotaStatus(remaining, total),
        errorCode: null,
      };
    } catch {
      return safeErrorSnapshot("REQUEST_TIMEOUT");
    }
  }

  async #fetchVisitsWithTimeout(visitsUrl: string, secretKey: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetchVisits(visitsUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          "secret-key": secretKey,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class SellerSpriteQuotaRefreshConfigurationError extends Error {
  readonly statusCode = 503;
  readonly apiErrorCode = "CONFIGURATION_ERROR";

  constructor() {
    super("SellerSprite quota refresh is not configured");
    this.name = "SellerSpriteQuotaRefreshConfigurationError";
  }
}

export class SellerSpriteQuotaRefreshScheduler {
  readonly #service: Pick<ConcurrencyAdminService, "refreshQuota">;
  readonly #organizationId: string;
  readonly #enabled: boolean;
  readonly #intervalMs: number;
  readonly #setInterval: (callback: () => void, ms: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;
  #timer: unknown | null = null;

  constructor(options: {
    service: Pick<ConcurrencyAdminService, "refreshQuota">;
    organizationId: string;
    enabled: boolean;
    intervalMs?: number;
    setInterval?: (callback: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
  }) {
    this.#service = options.service;
    this.#organizationId = options.organizationId;
    this.#enabled = options.enabled;
    this.#intervalMs = options.intervalMs ?? 45 * 60 * 1000;
    this.#setInterval = options.setInterval ?? setInterval;
    this.#clearInterval = options.clearInterval ??
      ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  start(): void {
    if (!this.#enabled || this.#timer !== null) return;
    this.#timer = this.#setInterval(() => {
      void this.#service.refreshQuota({
        organizationId: this.#organizationId,
        actorUserId: null,
      }).catch(() => undefined);
    }, this.#intervalMs);
  }

  async stop(): Promise<void> {
    if (this.#timer === null) return;
    const timer = this.#timer;
    this.#timer = null;
    this.#clearInterval(timer);
  }
}

function classifyQuotaStatus(
  remaining: number | null,
  total: number | null,
): ConcurrencyAdminResponse["sellerSpriteQuota"]["status"] {
  if (remaining === 0) return "paused";
  if (remaining === null || total === null) return "ok";
  const ratio = remaining / total;
  if (ratio < 0.1) return "conservative";
  if (ratio < 0.2) return "warning";
  return "ok";
}

function safeErrorSnapshot(
  errorCode: "MALFORMED_RESPONSE" | "UPSTREAM_UNAVAILABLE" | "REQUEST_TIMEOUT",
) {
  return {
    remaining: null,
    used: null,
    providerTotal: null,
    source: "provider" as const,
    status: "error" as const,
    errorCode,
  };
}

function validateVisitsUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/v1/visits" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("SellerSprite visits URL must be an explicit HTTPS /v1/visits endpoint");
  }
  return url.toString();
}
