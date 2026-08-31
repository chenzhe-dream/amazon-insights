import "server-only";

import type {
  ManualAlexaVocRepository,
  ManualAlexaVocRevision,
} from "../db/manual-alexa-voc-repository";
import { ManualAlexaVocRepositoryError } from "../db/manual-alexa-voc-repository";
import {
  ManualAlexaVocProjectionStoreError,
  type ManualAlexaVocProjectionPublishResult,
} from "../data/manual-alexa-voc-projection-store";

export type ManualAlexaVocMetricName =
  | "manual_alexa_voc_write_total"
  | "manual_alexa_voc_read_total"
  | "manual_alexa_voc_overlay_lag_ms"
  | "manual_alexa_voc_cutoff_excluded_total"
  | "manual_alexa_voc_publication_total"
  | "manual_alexa_voc_publication_lag_seconds"
  | "manual_alexa_voc_outbox_total"
  | "manual_alexa_voc_stale_epoch_response_dropped_total"
  | "manual_alexa_voc_legacy_gate_total";

type SafeTelemetryLabels = Readonly<
  Partial<Record<"result" | "source" | "status", string>>
>;

export interface ManualAlexaVocTelemetry {
  increment(
    name: ManualAlexaVocMetricName,
    labels?: SafeTelemetryLabels,
  ): void;
  observe(
    name: ManualAlexaVocMetricName,
    value: number,
    labels?: SafeTelemetryLabels,
  ): void;
}

export interface ManualAlexaVocProjectionWriter {
  publish(
    input: ManualAlexaVocRevision,
  ): Promise<ManualAlexaVocProjectionPublishResult>;
}

export type ManualAlexaVocDispatchResult =
  | Readonly<{ status: "idle" }>
  | Readonly<{
      status: "applied";
      artifactGeneration: string;
      projectionChanged: boolean;
    }>
  | Readonly<{ status: "failed" | "dead-letter"; errorCode: string }>
  | Readonly<{ status: "lease-lost" }>;

const DEAD_LETTER_AT = "9999-12-31T23:59:59.999Z";

const noOpTelemetry: ManualAlexaVocTelemetry = Object.freeze({
  increment() {},
  observe() {},
});

export class ManualAlexaVocPublicationService {
  readonly #repository: ManualAlexaVocRepository;
  readonly #projectionStore: ManualAlexaVocProjectionWriter;
  readonly #ownerId: string;
  readonly #enabled: boolean;
  readonly #leaseDurationMs: number;
  readonly #pollIntervalMs: number;
  readonly #reconcileIntervalMs: number;
  readonly #retryInitialDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #retryMaxAttempts: number;
  readonly #clock: () => Date;
  readonly #telemetry: ManualAlexaVocTelemetry;
  readonly #setInterval: (callback: () => void, ms: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;
  readonly #inFlight = new Set<Promise<unknown>>();
  #dispatchTimer: unknown | null = null;
  #reconcileTimer: unknown | null = null;
  #dispatchActive = false;
  #reconcileActive = false;

  constructor(options: Readonly<{
    repository: ManualAlexaVocRepository;
    projectionStore: ManualAlexaVocProjectionWriter;
    ownerId: string;
    enabled?: boolean;
    leaseDurationMs: number;
    pollIntervalMs?: number;
    reconcileIntervalMs?: number;
    retryInitialDelayMs: number;
    retryMaxDelayMs: number;
    retryMaxAttempts: number;
    clock?: () => Date;
    telemetry?: ManualAlexaVocTelemetry;
    setInterval?: (callback: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
  }>) {
    this.#repository = options.repository;
    this.#projectionStore = options.projectionStore;
    this.#ownerId = validateOwnerId(options.ownerId);
    this.#enabled = options.enabled ?? true;
    this.#leaseDurationMs = positiveInteger(options.leaseDurationMs);
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1_000);
    this.#reconcileIntervalMs = positiveInteger(
      options.reconcileIntervalMs ?? 60_000,
    );
    this.#retryInitialDelayMs = positiveInteger(options.retryInitialDelayMs);
    this.#retryMaxDelayMs = positiveInteger(options.retryMaxDelayMs);
    this.#retryMaxAttempts = positiveInteger(options.retryMaxAttempts);
    if (
      this.#pollIntervalMs >= this.#leaseDurationMs ||
      this.#reconcileIntervalMs < this.#pollIntervalMs ||
      this.#retryInitialDelayMs > this.#retryMaxDelayMs ||
      this.#retryMaxAttempts > 100
    ) {
      throw new TypeError("Manual Alexa VOC publication configuration is invalid");
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#telemetry = options.telemetry ?? noOpTelemetry;
    this.#setInterval = options.setInterval ?? setInterval;
    this.#clearInterval = options.clearInterval ??
      ((handle: unknown) => clearInterval(
        handle as ReturnType<typeof setInterval>,
      ));
  }

  async dispatchOnce(): Promise<ManualAlexaVocDispatchResult> {
    const leasedAt = this.#now();
    const lease = await this.#repository.leasePublication({
      ownerId: this.#ownerId,
      leasedAt,
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (!lease) return Object.freeze({ status: "idle" });
    this.#telemetry.increment("manual_alexa_voc_publication_total", {
      status: "leased",
    });
    this.#telemetry.increment("manual_alexa_voc_outbox_total", {
      status: "leased",
    });

    try {
      const head = await this.#repository.getCurrent({
        organizationId: lease.organizationId,
        marketplace: lease.marketplace,
        asin: lease.asin,
      });
      const publishable = requirePublishableHead(head, lease);
      const publication = await this.#projectionStore.publish(publishable);
      const appliedAt = this.#now();
      await this.#repository.markPublicationApplied({
        ...lease,
        appliedAt,
      });
      this.#telemetry.increment("manual_alexa_voc_publication_total", {
        status: "applied",
      });
      this.#telemetry.increment("manual_alexa_voc_outbox_total", {
        status: "applied",
      });
      this.#telemetry.observe(
        "manual_alexa_voc_publication_lag_seconds",
        Math.max(
          0,
          (new Date(appliedAt).getTime() -
            new Date(publishable.capturedAt).getTime()) / 1_000,
        ),
        { status: "applied" },
      );
      return Object.freeze({
        status: "applied",
        artifactGeneration: publication.artifactGeneration,
        projectionChanged: publication.changed,
      });
    } catch (error) {
      const terminal = BigInt(lease.leaseGeneration) >=
        BigInt(this.#retryMaxAttempts);
      const failedAt = this.#now();
      const errorCode = terminal
        ? "MANUAL_VOC_PUBLICATION_DEAD_LETTER"
        : safePublicationErrorCode(error);
      const nextAttemptAt = terminal
        ? DEAD_LETTER_AT
        : new Date(
            new Date(failedAt).getTime() + this.#retryDelay(lease.leaseGeneration),
          ).toISOString();
      try {
        await this.#repository.markPublicationFailed({
          ...lease,
          failedAt,
          nextAttemptAt,
          errorCode,
        });
      } catch {
        this.#telemetry.increment("manual_alexa_voc_publication_total", {
          status: "failed",
        });
        return Object.freeze({ status: "lease-lost" });
      }
      this.#telemetry.increment("manual_alexa_voc_publication_total", {
        status: "failed",
      });
      this.#telemetry.increment("manual_alexa_voc_outbox_total", {
        status: "failed",
      });
      return Object.freeze({
        status: terminal ? "dead-letter" : "failed",
        errorCode,
      });
    }
  }

  async reconcileOnce(): Promise<number> {
    const repaired = await this.#repository.reconcilePublication({
      reconciledAt: this.#now(),
    });
    if (repaired > 0) {
      this.#telemetry.increment("manual_alexa_voc_outbox_total", {
        status: "pending",
      });
    }
    return repaired;
  }

  start(): void {
    if (!this.#enabled || this.#dispatchTimer !== null) return;
    this.#dispatchTimer = this.#setInterval(
      () => this.#schedule("dispatch"),
      this.#pollIntervalMs,
    );
    this.#reconcileTimer = this.#setInterval(
      () => this.#schedule("reconcile"),
      this.#reconcileIntervalMs,
    );
  }

  async stop(): Promise<void> {
    if (this.#dispatchTimer !== null) {
      this.#clearInterval(this.#dispatchTimer);
      this.#dispatchTimer = null;
    }
    if (this.#reconcileTimer !== null) {
      this.#clearInterval(this.#reconcileTimer);
      this.#reconcileTimer = null;
    }
    await Promise.allSettled([...this.#inFlight]);
  }

  #schedule(kind: "dispatch" | "reconcile") {
    if (
      (kind === "dispatch" && this.#dispatchActive) ||
      (kind === "reconcile" && this.#reconcileActive)
    ) {
      return;
    }
    if (kind === "dispatch") this.#dispatchActive = true;
    else this.#reconcileActive = true;
    const operation = kind === "dispatch"
      ? this.dispatchOnce()
      : this.reconcileOnce();
    const tracked = operation
      .catch(() => {
        this.#telemetry.increment("manual_alexa_voc_publication_total", {
          status: "failed",
        });
      })
      .finally(() => {
        if (kind === "dispatch") this.#dispatchActive = false;
        else this.#reconcileActive = false;
        this.#inFlight.delete(tracked);
      });
    this.#inFlight.add(tracked);
  }

  #retryDelay(leaseGeneration: string) {
    const exponent = Number(
      BigInt(leaseGeneration) > BigInt(31)
        ? BigInt(30)
        : BigInt(leaseGeneration) - BigInt(1),
    );
    return Math.min(
      this.#retryMaxDelayMs,
      this.#retryInitialDelayMs * (2 ** exponent),
    );
  }

  #now() {
    const timestamp = this.#clock();
    if (Number.isNaN(timestamp.getTime())) {
      throw new TypeError("Manual Alexa VOC publication clock is invalid");
    }
    return timestamp.toISOString();
  }
}

function requirePublishableHead(
  head: ManualAlexaVocRevision | null,
  lease: Readonly<{
    revision: string;
    contentHash: string;
  }>,
) {
  if (!head) throw new ManualAlexaVocPublicationSourceError();
  const order = BigInt(head.revision) - BigInt(lease.revision);
  if (
    order < BigInt(0) ||
    (order === BigInt(0) && head.contentHash !== lease.contentHash)
  ) {
    throw new ManualAlexaVocPublicationSourceError();
  }
  return head;
}

class ManualAlexaVocPublicationSourceError extends Error {
  constructor() {
    super("Manual Alexa VOC publication source conflicts with its outbox lease");
    this.name = "ManualAlexaVocPublicationSourceError";
  }
}

function safePublicationErrorCode(error: unknown) {
  if (error instanceof ManualAlexaVocProjectionStoreError) {
    return error.code === "PROJECTION_BUSY"
      ? "MANUAL_VOC_PROJECTION_BUSY"
      : error.code === "PROJECTION_CONFLICT"
        ? "MANUAL_VOC_PROJECTION_CONFLICT"
        : "MANUAL_VOC_PROJECTION_IO";
  }
  if (error instanceof ManualAlexaVocRepositoryError) {
    return "MANUAL_VOC_PUBLICATION_REPOSITORY";
  }
  if (error instanceof ManualAlexaVocPublicationSourceError) {
    return "MANUAL_VOC_PUBLICATION_SOURCE_CONFLICT";
  }
  return "MANUAL_VOC_PUBLICATION_FAILED";
}

function validateOwnerId(value: string) {
  if (!value || value.trim() !== value || value.length > 200) {
    throw new TypeError("Manual Alexa VOC publication owner is invalid");
  }
  return value;
}

function positiveInteger(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Manual Alexa VOC publication configuration is invalid");
  }
  return value;
}
