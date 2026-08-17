import type {
  KeywordAnalysisSnapshotCandidate,
  KeywordAnalysisSnapshotRecord,
} from "../data/keyword-analysis-snapshot";
import type { DataSnapshotSubjectInput } from "./data-snapshot-repository";

export interface CreateKeywordAnalysisSnapshotForRunInput
  extends DataSnapshotSubjectInput {
  candidateId: string;
  createdAt: string;
  candidate: KeywordAnalysisSnapshotCandidate;
}

export interface KeywordAnalysisSnapshotRepository {
  createKeywordAnalysisSnapshotForRun(
    input: CreateKeywordAnalysisSnapshotForRunInput,
  ): Promise<{ snapshot: KeywordAnalysisSnapshotRecord; created: boolean }>;
  findKeywordAnalysisSnapshotById(input: {
    actorOrganizationId: string;
    snapshotId: string;
  }): Promise<KeywordAnalysisSnapshotRecord | null>;
  listKeywordAnalysisSnapshotsByRun(input: {
    actorOrganizationId: string;
    runId: string;
  }): Promise<KeywordAnalysisSnapshotRecord[]>;
  getKeywordAnalysisArtifact(runId: string): Promise<
    | Readonly<{ available: false; version: null }>
    | Readonly<{ available: true; version: string }>
  >;
}

export class KeywordAnalysisSnapshotConflictError extends Error {
  constructor() {
    super("A keyword analysis snapshot with this semantic identity has different content");
    this.name = "KeywordAnalysisSnapshotConflictError";
  }
}

export class KeywordAnalysisSnapshotDataError extends Error {
  constructor() {
    super("Stored keyword analysis snapshot failed integrity validation");
    this.name = "KeywordAnalysisSnapshotDataError";
  }
}
