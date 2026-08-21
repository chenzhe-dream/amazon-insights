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
}

export interface RecordPhysicalAttemptInput {
  readonly organizationId: string;
  readonly resource: GovernedResource;
  readonly jobId: string;
  readonly attemptKind: GovernedAttemptKind;
  readonly recordedAt?: string;
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
  recordPhysicalAttempt(input: RecordPhysicalAttemptInput): Promise<void>;
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
  }): Promise<T>;
}

export class ResourceGovernorAdmissionError extends Error {
  constructor(options?: ErrorOptions) {
    super("External request capacity is temporarily unavailable", options);
    this.name = "ResourceGovernorAdmissionError";
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
  }): Promise<T> {
    const permit = await this.repository.acquirePermit({
      organizationId: input.organizationId,
      resource: input.resource,
      jobId: input.jobId,
      attemptKind: input.attemptKind,
      ownerId: this.ownerId,
      leaseMs: input.leaseMs ?? 120_000,
      maxWaitMs: input.maxWaitMs ?? 5_000,
    });
    try {
      await this.repository.recordPhysicalAttempt({
        organizationId: input.organizationId,
        resource: input.resource,
        jobId: input.jobId,
        attemptKind: input.attemptKind,
      });
      return await input.operation();
    } finally {
      await this.repository.releasePermit({
        permitId: permit.permitId,
        ownerId: permit.ownerId,
        leaseGeneration: permit.leaseGeneration,
      }).catch(() => undefined);
    }
  }
}
