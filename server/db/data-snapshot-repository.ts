import type {
  VocDataSnapshotRecord,
  VocSnapshotCandidate,
} from "../data/voc-data-snapshot";

export interface CreateDataSnapshotForRunInput {
  actorOrganizationId: string;
  runId: string;
  expectedProjectId: string;
  expectedMarketplace: string;
  expectedAsins: readonly string[];
  expectedRunCutoffAt: string;
  candidateId: string;
  createdAt: string;
  candidate: VocSnapshotCandidate;
}

export interface CreateDataSnapshotForRunResult {
  snapshot: VocDataSnapshotRecord;
  created: boolean;
}

export interface FindDataSnapshotByIdInput {
  actorOrganizationId: string;
  snapshotId: string;
}

export interface ListDataSnapshotsByRunInput {
  actorOrganizationId: string;
  runId: string;
}

export interface DataSnapshotRepository {
  createDataSnapshotForRun(
    input: CreateDataSnapshotForRunInput,
  ): Promise<CreateDataSnapshotForRunResult>;
  findDataSnapshotById(
    input: FindDataSnapshotByIdInput,
  ): Promise<VocDataSnapshotRecord | null>;
  listDataSnapshotsByRun(
    input: ListDataSnapshotsByRunInput,
  ): Promise<VocDataSnapshotRecord[]>;
}

export class DataSnapshotConflictError extends Error {
  constructor() {
    super("A VOC data snapshot with this semantic identity has different content");
    this.name = "DataSnapshotConflictError";
  }
}

export class DataSnapshotSubjectNotFoundError extends Error {
  constructor() {
    super("The trusted analysis run snapshot target was not found");
    this.name = "DataSnapshotSubjectNotFoundError";
  }
}

export class DataSnapshotDataError extends Error {
  constructor() {
    super("Stored VOC data snapshot failed integrity validation");
    this.name = "DataSnapshotDataError";
  }
}
