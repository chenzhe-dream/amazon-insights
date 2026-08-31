import { randomUUID } from "node:crypto";

import { EntityIdSchema } from "../../shared/agent-contracts";
import type {
  DataSnapshotRepository,
} from "../db/data-snapshot-repository";
import {
  DataSnapshotConflictError,
  DataSnapshotCutoffConflictError,
  DataSnapshotSubjectNotFoundError,
} from "../db/data-snapshot-repository";
import type {
  AgentRepository,
  ManualAlexaVocRepositoryCapability,
} from "../db/repository";
import {
  RepositoryVocSourceReader,
  type RepositoryVocReadInput,
  type RepositoryVocReadResult,
} from "../data/repository-voc-source";
import {
  deepFreeze,
  type MissingVocSource,
  type VocDataSnapshotRecord,
  type VocSnapshotCandidate,
} from "../data/voc-data-snapshot";
import type { AnalysisExecutionContext } from "./analysis-run-service";

type SnapshotRepository = AgentRepository &
  DataSnapshotRepository &
  ManualAlexaVocRepositoryCapability;

export interface VocDataSnapshotLogSummary {
  readonly runId: string;
  readonly snapshotId: string | null;
  readonly sourceCount: number;
  readonly recordCount: number;
  readonly contentHashPrefix: string | null;
}

export interface VocDataSnapshotServiceOptions {
  readonly repository: SnapshotRepository;
  readonly executionContext: AnalysisExecutionContext;
  readonly sourceReader?: Readonly<{
    read(input: RepositoryVocReadInput): Promise<RepositoryVocReadResult>;
  }>;
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly logger?: (summary: VocDataSnapshotLogSummary) => void;
}

export type CreateVocDataSnapshotResult =
  | Readonly<{
      status: "ready";
      snapshot: VocDataSnapshotRecord;
      missingSources: readonly [];
    }>
  | Readonly<{
      status: "waiting-input";
      snapshot: VocDataSnapshotRecord | null;
      missingSources: readonly MissingVocSource[];
    }>;

export interface PersistVocDataSnapshotInput {
  readonly repository: DataSnapshotRepository;
  readonly actorId: string;
  readonly organizationId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly marketplace: string;
  readonly asins: readonly string[];
  readonly dataCutoffAt: string;
  readonly candidateId: string;
  readonly createdAt: string;
  readonly candidate: VocSnapshotCandidate;
}

export class VocDataSnapshotServiceError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "NOT_FOUND" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "VocDataSnapshotServiceError";
  }
}

/**
 * Persists an already-selected immutable VOC candidate. The caller controls
 * the surrounding repository transaction, so atomic run creation can bind
 * the snapshot to the exact database cutoff used for source selection.
 */
export async function persistVocDataSnapshot(
  input: PersistVocDataSnapshotInput,
): Promise<VocDataSnapshotRecord> {
  try {
    const persisted = await input.repository.createDataSnapshotForRun({
      actorId: input.actorId,
      actorOrganizationId: input.organizationId,
      runId: input.runId,
      expectedProjectId: input.projectId,
      expectedMarketplace: input.marketplace,
      expectedAsins: input.asins,
      expectedRunCutoffAt: input.dataCutoffAt,
      candidateId: input.candidateId,
      createdAt: input.createdAt,
      candidate: input.candidate,
    });
    return persisted.snapshot;
  } catch (error) {
    if (
      error instanceof DataSnapshotSubjectNotFoundError ||
      error instanceof DataSnapshotConflictError ||
      error instanceof DataSnapshotCutoffConflictError
    ) {
      throw new VocDataSnapshotServiceError(
        "CONFLICT",
        "Trusted analysis run changed while creating its data snapshot",
      );
    }
    throw error;
  }
}

export class VocDataSnapshotService {
  readonly #repository: SnapshotRepository;
  readonly #context: AnalysisExecutionContext;
  readonly #sourceReader: VocDataSnapshotServiceOptions["sourceReader"];
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #logger: (summary: VocDataSnapshotLogSummary) => void;

  constructor(options: VocDataSnapshotServiceOptions) {
    this.#repository = options.repository;
    this.#context = deepFreeze({ ...options.executionContext });
    this.#sourceReader = options.sourceReader ?? new RepositoryVocSourceReader({
      manualVoc: options.repository.manualAlexaVoc,
    });
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? randomUUID;
    this.#logger = options.logger ?? (() => undefined);
  }

  async createForRun(runId: string): Promise<CreateVocDataSnapshotResult> {
    const trustedRunId = EntityIdSchema.parse(runId);
    const actor = await this.#repository.findUserById(this.#context.actorId);
    if (
      !actor ||
      actor.status !== "active" ||
      actor.organizationId !== this.#context.organizationId
    ) {
      throw new VocDataSnapshotServiceError(
        "FORBIDDEN",
        "Execution actor is not active in the trusted organization",
      );
    }

    const run = await this.#repository.findAnalysisRun(trustedRunId);
    if (!run) {
      throw new VocDataSnapshotServiceError("NOT_FOUND", "Analysis run not found");
    }
    const project = await this.#repository.findProjectById(run.projectId);
    if (!project || project.organizationId !== this.#context.organizationId) {
      throw new VocDataSnapshotServiceError("NOT_FOUND", "Analysis run not found");
    }

    // Dynamic source selection, filtering, validation, and hashing complete
    // before snapshot persistence opens its transaction.
    const sourceResult = await this.#sourceReader!.read({
      organizationId: this.#context.organizationId,
      marketplace: project.marketplace,
      asins: project.asins,
      dataCutoffAt: run.dataCutoffAt,
    });
    if (!sourceResult.candidate) {
      try {
        await this.#repository.revalidateDataSnapshotSubject({
          actorId: this.#context.actorId,
          actorOrganizationId: this.#context.organizationId,
          runId: run.id,
          expectedProjectId: project.id,
          expectedMarketplace: project.marketplace,
          expectedAsins: project.asins,
          expectedRunCutoffAt: run.dataCutoffAt,
        });
      } catch (error) {
        if (error instanceof DataSnapshotSubjectNotFoundError) {
          throw new VocDataSnapshotServiceError(
            "CONFLICT",
            "Trusted analysis run changed while reading snapshot inputs",
          );
        }
        throw error;
      }
      const result = deepFreeze({
        status: "waiting-input" as const,
        snapshot: null,
        missingSources: sourceResult.missingSources,
      });
      this.#log({
        runId: run.id,
        snapshotId: null,
        sourceCount: 0,
        recordCount: 0,
        contentHashPrefix: null,
      });
      return result;
    }

    const snapshot = await persistVocDataSnapshot({
      repository: this.#repository,
      actorId: this.#context.actorId,
      organizationId: this.#context.organizationId,
      runId: run.id,
      projectId: project.id,
      marketplace: project.marketplace,
      asins: project.asins,
      dataCutoffAt: run.dataCutoffAt,
      candidateId: this.#createId(),
      createdAt: this.#now(),
      candidate: sourceResult.candidate,
    });

    const result: CreateVocDataSnapshotResult =
      sourceResult.missingSources.length === 0
        ? deepFreeze({
            status: "ready" as const,
            snapshot,
            missingSources: [] as const,
          })
        : deepFreeze({
            status: "waiting-input" as const,
            snapshot,
            missingSources: sourceResult.missingSources,
          });
    this.#log({
      runId: run.id,
      snapshotId: snapshot.id,
      sourceCount: snapshot.sources.length,
      recordCount: sourceResult.recordCount,
      contentHashPrefix: snapshot.contentHash.slice(0, 12),
    });
    return result;
  }

  #log(summary: VocDataSnapshotLogSummary) {
    try {
      this.#logger(deepFreeze({ ...summary }));
    } catch {
      // Logging is observational and must never change snapshot persistence.
    }
  }
}
