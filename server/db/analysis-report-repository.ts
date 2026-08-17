import type {
  AnalysisReport,
  SkillProvenance,
} from "../../shared/agent-contracts";
import type { VocPositioningOutput } from "../domain/voc/voc-positioning-contracts";
import type { TrafficAnalysisOutput } from "../domain/traffic/traffic-analysis-contracts";

export interface PublishVocPositioningReportInput {
  id: string;
  actorId: string;
  actorOrganizationId: string;
  expectedProjectId: string;
  runId: string;
  stageId: string;
  jobAttemptId: string;
  agentRunId: string;
  logicalExecutionLineage: string;
  snapshotId: string;
  factsDigest: string;
  skill: SkillProvenance;
  model: {
    provider: string;
    model: string;
    responseId?: string;
  };
  leaseOwnerId: string;
  leaseGeneration: number;
  publishedAt: string;
  result: VocPositioningOutput;
}

export interface PublishVocPositioningReportResult {
  report: Readonly<AnalysisReport<VocPositioningOutput>>;
  created: boolean;
}

export interface PublishTrafficAnalysisReportInput {
  id: string;
  actorId: string;
  actorOrganizationId: string;
  expectedProjectId: string;
  runId: string;
  stageId: string;
  jobAttemptId: string;
  agentRunId: string;
  logicalExecutionLineage: string;
  snapshotId: string;
  skill: SkillProvenance;
  model: { provider: string; model: string; responseId?: string };
  leaseOwnerId: string;
  leaseGeneration: number;
  publishedAt: string;
  result: TrafficAnalysisOutput;
}

export interface PublishTrafficAnalysisReportResult {
  report: Readonly<AnalysisReport<TrafficAnalysisOutput>>;
  created: boolean;
}

export interface ListAnalysisReportsInput {
  actorOrganizationId: string;
  runId: string;
  stage: "traffic-analysis" | "voc-positioning";
}

export interface FindAnalysisReportByIdInput {
  actorOrganizationId: string;
  reportId: string;
}

export interface AnalysisReportRepository {
  publishVocPositioningReport(
    input: PublishVocPositioningReportInput,
  ): Promise<PublishVocPositioningReportResult>;
  publishTrafficAnalysisReport(
    input: PublishTrafficAnalysisReportInput,
  ): Promise<PublishTrafficAnalysisReportResult>;
  listAnalysisReports(
    input: ListAnalysisReportsInput,
  ): Promise<ReadonlyArray<Readonly<AnalysisReport<VocPositioningOutput | TrafficAnalysisOutput>>>>;
  findAnalysisReportById(
    input: FindAnalysisReportByIdInput,
  ): Promise<Readonly<AnalysisReport<VocPositioningOutput | TrafficAnalysisOutput>> | null>;
}

export class AnalysisReportConflictError extends Error {
  readonly code = "ANALYSIS_REPORT_CONFLICT";

  constructor() {
    super("Analysis report conflicts with persisted execution identity");
    this.name = "AnalysisReportConflictError";
  }
}

export class AnalysisReportSubjectNotFoundError extends Error {
  readonly code = "ANALYSIS_REPORT_SUBJECT_NOT_FOUND";

  constructor() {
    super("Analysis report subject was not found or is not available");
    this.name = "AnalysisReportSubjectNotFoundError";
  }
}

export class AnalysisReportLeaseLostError extends Error {
  readonly code = "ANALYSIS_REPORT_LEASE_LOST";

  constructor() {
    super("Analysis report execution lease or claim is no longer active");
    this.name = "AnalysisReportLeaseLostError";
  }
}

export class AnalysisReportDataError extends Error {
  readonly code = "ANALYSIS_REPORT_DATA_INVALID";

  constructor() {
    super("Stored analysis report data is invalid");
    this.name = "AnalysisReportDataError";
  }
}
