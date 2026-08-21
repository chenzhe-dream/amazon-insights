import type {
  TrafficDataSnapshotRecord,
  TrafficSnapshotCandidate,
} from "../data/traffic-data-snapshot";
import type { DataSnapshotSubjectInput } from "./data-snapshot-repository";

export interface CreateTrafficDataSnapshotForRunInput
  extends DataSnapshotSubjectInput {
  candidateId: string;
  createdAt: string;
  candidate: TrafficSnapshotCandidate;
}

export interface TrafficDataSnapshotRepository {
  createTrafficDataSnapshotForRun(
    input: CreateTrafficDataSnapshotForRunInput,
  ): Promise<{ snapshot: TrafficDataSnapshotRecord; created: boolean }>;
  findTrafficDataSnapshotById(input: {
    actorOrganizationId: string;
    snapshotId: string;
  }): Promise<TrafficDataSnapshotRecord | null>;
  listTrafficDataSnapshotsByRun(input: {
    actorOrganizationId: string;
    runId: string;
  }): Promise<TrafficDataSnapshotRecord[]>;
}

export class TrafficDataSnapshotConflictError extends Error {
  constructor() {
    super("A traffic data snapshot with this semantic identity has different content");
    this.name = "TrafficDataSnapshotConflictError";
  }
}

export class TrafficDataSnapshotDataError extends Error {
  constructor() {
    super("Stored traffic data snapshot failed integrity validation");
    this.name = "TrafficDataSnapshotDataError";
  }
}
