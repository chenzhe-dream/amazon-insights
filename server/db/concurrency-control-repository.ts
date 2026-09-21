import type {
  ConcurrencyPolicy,
  GovernedAttemptKind,
  GovernedResource,
} from "../concurrency/concurrency-policy";

export type { GovernedAttemptKind, GovernedResource };

export interface ResourcePermit {
  readonly permitId: string;
  readonly organizationId: string;
  readonly resource: GovernedResource;
  readonly jobId: string;
  readonly attemptKind: GovernedAttemptKind;
  readonly ownerId: string;
  readonly leaseGeneration: number;
  readonly policyVersion: string;
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
}

export interface AcquirePermitInput {
  readonly organizationId: string;
  readonly resource: GovernedResource;
  readonly jobId: string;
  readonly attemptKind: GovernedAttemptKind;
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly maxWaitMs?: number;
  readonly acquiredAt?: string;
  readonly signal?: AbortSignal;
}

export interface RecordPhysicalAttemptInput {
  readonly organizationId: string;
  readonly resource: GovernedResource;
  readonly jobId: string;
  readonly attemptKind: GovernedAttemptKind;
  readonly recordedAt?: string;
  readonly signal?: AbortSignal;
}

export interface PhysicalAttemptReceipt {
  readonly attemptId: string;
  readonly organizationId: string;
  readonly resource: GovernedResource;
  readonly jobId: string;
  readonly attemptKind: GovernedAttemptKind;
  readonly policyVersion: string;
  readonly recordedAt: string;
}

export interface ConcurrencyControlRepository {
  getEffectivePolicy(organizationId: string): Promise<ConcurrencyPolicy>;
  acquirePermit(input: AcquirePermitInput): Promise<ResourcePermit>;
  heartbeatPermit(input: {
    permitId: string;
    ownerId: string;
    leaseGeneration: number;
    leaseMs: number;
    heartbeatAt?: string;
  }): Promise<boolean>;
  releasePermit(input: {
    permitId: string;
    ownerId: string;
    leaseGeneration: number;
    releasedAt?: string;
  }): Promise<boolean>;
  recordPhysicalAttempt(input: RecordPhysicalAttemptInput): Promise<PhysicalAttemptReceipt>;
  cancelUndispatchedPhysicalAttempt(receipt: PhysicalAttemptReceipt): Promise<boolean>;
}

export interface ResourceGovernor {
  run<T>(input: {
    readonly organizationId: string;
    readonly resource: GovernedResource;
    readonly jobId: string;
    readonly attemptKind: GovernedAttemptKind;
    readonly operation: () => Promise<T>;
    readonly leaseMs?: number;
    readonly maxWaitMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<T>;
}

export const LOCAL_ADMISSION_REASONS = ['rolling-window', 'concurrency', 'paused', 'unavailable', 'cancelled'] as const;
export type LocalAdmission = { reason: typeof LOCAL_ADMISSION_REASONS[number]; retryAt: string | null };
export class ResourceGovernorAdmissionError extends Error {
  readonly reason: LocalAdmission['reason'];
  readonly retryAt: string | null;
  constructor(options?: ErrorOptions & Partial<LocalAdmission>) {
    super("External request capacity is temporarily unavailable", options);
    this.name = "ResourceGovernorAdmissionError";
    this.reason = options?.reason ?? 'unavailable';
    this.retryAt = this.reason === 'rolling-window' && options?.retryAt && Number.isFinite(Date.parse(options.retryAt)) ? new Date(options.retryAt).toISOString() : null;
  }
}

export class UnavailableConcurrencyControlRepository implements ConcurrencyControlRepository {
  getEffectivePolicy(): Promise<never> {
    return Promise.reject(new ResourceGovernorAdmissionError());
  }
  acquirePermit(): Promise<never> {
    return Promise.reject(new ResourceGovernorAdmissionError());
  }
  heartbeatPermit(): Promise<never> {
    return Promise.reject(new ResourceGovernorAdmissionError());
  }
  releasePermit(): Promise<never> {
    return Promise.reject(new ResourceGovernorAdmissionError());
  }
  recordPhysicalAttempt(): Promise<never> {
    return Promise.reject(new ResourceGovernorAdmissionError());
  }
  cancelUndispatchedPhysicalAttempt(): Promise<never> {
    return Promise.reject(new ResourceGovernorAdmissionError());
  }
}

export class PostgresResourceGovernor implements ResourceGovernor {
  constructor(
    private readonly repository: ConcurrencyControlRepository,
    private readonly ownerId: string,
  ) {}

  async run<T>(input: {
    organizationId: string;
    resource: GovernedResource;
    jobId: string;
    attemptKind: GovernedAttemptKind;
    operation: () => Promise<T>;
    leaseMs?: number;
    maxWaitMs?: number;
    signal?: AbortSignal;
  }): Promise<T> {
    assertAdmissionActive(input.signal);
    const permit = await this.repository.acquirePermit({
      organizationId: input.organizationId,
      resource: input.resource,
      jobId: input.jobId,
      attemptKind: input.attemptKind,
      ownerId: this.ownerId,
      leaseMs: input.leaseMs ?? 120_000,
      maxWaitMs: input.maxWaitMs ?? 5_000,
      signal: input.signal,
    });
    try {
      assertAdmissionActive(input.signal);
      const receipt = await this.repository.recordPhysicalAttempt({
        organizationId: input.organizationId,
        resource: input.resource,
        jobId: input.jobId,
        attemptKind: input.attemptKind,
        signal: input.signal,
      });
      if (input.signal?.aborted) {
        await this.compensateUndispatchedAttempt(receipt);
        throw new ResourceGovernorAdmissionError({reason:'cancelled'});
      }
      return await input.operation();
    } finally {
      await this.repository.releasePermit({
        permitId: permit.permitId,
        ownerId: permit.ownerId,
        leaseGeneration: permit.leaseGeneration,
      }).catch(() => undefined);
    }
  }

  private async compensateUndispatchedAttempt(
    receipt: PhysicalAttemptReceipt,
  ): Promise<void> {
    try {
      if (!await this.repository.cancelUndispatchedPhysicalAttempt(receipt)) {
        throw new ResourceGovernorAdmissionError();
      }
    } catch (error) {
      if (error instanceof ResourceGovernorAdmissionError) throw error;
      throw new ResourceGovernorAdmissionError({ cause: error });
    }
  }
}

function assertAdmissionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ResourceGovernorAdmissionError({reason:'cancelled'});
}
