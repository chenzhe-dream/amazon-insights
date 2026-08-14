import { randomUUID } from "node:crypto";

import { EntityIdSchema } from "../../shared/agent-contracts";
import type {
  DataSnapshotRepository,
} from "../db/data-snapshot-repository";
import {
  DataSnapshotConflictError,
  DataSnapshotDataError,
  DataSnapshotSubjectNotFoundError,
} from "../db/data-snapshot-repository";
import type { AgentRepository } from "../db/repository";
import {
  RepositoryVocSourceReader,
  type RepositoryVocReadInput,
  type RepositoryVocReadResult,
} from "../data/repository-voc-source";
import {
  deepFreeze,
  type MissingVocSource,
  type VocDataSnapshotRecord,
} from "../data/voc-data-snapshot";
import type { AnalysisExecutionContext } from "./analysis-run-service";

type SnapshotRepository = AgentRepository & DataSnapshotRepository;

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
    read(input: RepositoryVocReadInput): RepositoryVocReadResult;
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

export class VocDataSnapshotServiceError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "NOT_FOUND" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "VocDataSnapshotServiceError";
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
    this.#sourceReader = options.sourceReader ?? new RepositoryVocSourceReader();
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

    // Static module reads, filtering, validation, and hashing happen before the
    // repository opens its synchronous immediate transaction.
    const sourceResult = this.#sourceReader!.read({
      marketplace: project.marketplace,
      asins: project.asins,
      dataCutoffAt: run.dataCutoffAt,
    });
    if (!sourceResult.candidate) {
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

    let snapshot: VocDataSnapshotRecord;
    try {
      const persisted = await this.#repository.createDataSnapshotForRun({
        actorOrganizationId: this.#context.organizationId,
        runId: run.id,
        expectedProjectId: project.id,
        expectedMarketplace: project.marketplace,
        expectedAsins: project.asins,
        expectedRunCutoffAt: run.dataCutoffAt,
        candidateId: this.#createId(),
        createdAt: this.#now(),
        candidate: sourceResult.candidate,
      });
      snapshot = persisted.snapshot;
    } catch (error) {
      if (
        error instanceof DataSnapshotSubjectNotFoundError ||
        error instanceof DataSnapshotConflictError ||
        error instanceof DataSnapshotDataError
      ) {
        throw new VocDataSnapshotServiceError(
          "CONFLICT",
          "Trusted analysis run changed while creating its data snapshot",
        );
      }
      throw error;
    }

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
