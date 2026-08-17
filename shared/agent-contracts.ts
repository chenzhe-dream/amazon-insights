import { z } from "zod";

const strictObject = z.strictObject;

export const EntityIdSchema = z.uuidv4();
export const RequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "Request ID must contain only safe ASCII correlation characters",
  );
export type RequestId = z.infer<typeof RequestIdSchema>;

export function normalizeRequestId(
  value: unknown,
  createFallback: () => string,
): RequestId {
  const parsed = RequestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : RequestIdSchema.parse(createFallback());
}

export const DateTimeSchema = z.iso.datetime({ offset: true });
export const SchemaVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "Expected a semantic schema version");
export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected lowercase SHA-256");
export const AsinSchema = z
  .string()
  .regex(/^[A-Z0-9]{10}$/, "ASIN must be 10 uppercase letters or digits");
export const MarketplaceSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, "Marketplace must be a two-letter code");

const AsinListSchema = z
  .array(AsinSchema)
  .min(3)
  .max(10)
  .refine((asins) => new Set(asins).size === asins.length, {
    message: "ASINs must be unique",
  });

export const UserRoleSchema = z.enum(["admin", "member"]);
export const UserStatusSchema = z.enum(["active", "disabled"]);
export const UserSchema = strictObject({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  email: z.email(),
  displayName: z.string().trim().min(1).max(200),
  role: UserRoleSchema,
  status: UserStatusSchema,
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

export const ProjectSchema = strictObject({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  name: z.string().trim().min(1).max(200),
  marketplace: MarketplaceSchema,
  asins: AsinListSchema,
  createdBy: EntityIdSchema,
  currentRunId: EntityIdSchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const StageNameSchema = z.enum([
  "traffic-analysis",
  "voc-positioning",
  "product-definition",
]);
export type StageName = z.infer<typeof StageNameSchema>;

export const RunStageStatusSchema = z.enum([
  "queued",
  "running",
  "waiting-input",
  "succeeded",
  "failed",
  "skipped",
  "budget-exceeded",
  "cancelled",
  "stale",
]);
export type RunStageStatus = z.infer<typeof RunStageStatusSchema>;

export const AnalysisRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting-input",
  "succeeded",
  "partial",
  "failed",
  "budget-exceeded",
  "cancelled",
]);
export type AnalysisRunStatus = z.infer<typeof AnalysisRunStatusSchema>;

export const RunModeSchema = z.enum(["existing-data", "collect-missing"]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const ApiErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "CONFIGURATION_ERROR",
  "AUTHENTICATION_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_TEMPORARY",
  "UPSTREAM_PERMANENT",
  "DATA_QUALITY_ERROR",
  "MODEL_OUTPUT_ERROR",
  "INFRASTRUCTURE_ERROR",
  "CANCELLED",
  "INTERNAL_SERVER_ERROR",
  "AGENT_SERVICE_UNAVAILABLE",
  "AGENT_SERVICE_TIMEOUT",
  "AGENT_SERVICE_RESPONSE_TOO_LARGE",
  "AGENT_SERVICE_INVALID_RESPONSE",
  "AGENT_SERVICE_UPSTREAM_ERROR",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorDetailSchema = strictObject({
  path: z.string().min(1),
  message: z.string().min(1),
});

export const ApiErrorSchema = strictObject({
  code: ApiErrorCodeSchema,
  message: z.string().min(1),
  requestId: RequestIdSchema,
  details: z.array(ApiErrorDetailSchema).optional(),
  retryable: z.boolean().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiErrorResponseSchema = strictObject({
  error: ApiErrorSchema,
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const AnalysisRunSchema = strictObject({
  id: EntityIdSchema,
  projectId: EntityIdSchema,
  mode: RunModeSchema,
  status: AnalysisRunStatusSchema,
  createdBy: EntityIdSchema,
  dataCutoffAt: DateTimeSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;

export const RunStageSchema = strictObject({
  id: EntityIdSchema,
  runId: EntityIdSchema,
  stage: StageNameSchema,
  status: RunStageStatusSchema,
  progress: z.number().int().min(0).max(100),
  attemptCount: z.number().int().min(0),
  startedAt: DateTimeSchema.nullable(),
  completedAt: DateTimeSchema.nullable(),
  lastError: ApiErrorSchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type RunStage = z.infer<typeof RunStageSchema>;

export const JobAttemptStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const JobAttemptSchema = strictObject({
  id: EntityIdSchema,
  stageId: EntityIdSchema,
  attemptNumber: z.number().int().positive(),
  status: JobAttemptStatusSchema,
  leasedBy: z.string().min(1).nullable(),
  leaseExpiresAt: DateTimeSchema.nullable(),
  startedAt: DateTimeSchema.nullable(),
  completedAt: DateTimeSchema.nullable(),
  error: ApiErrorSchema.nullable(),
  createdAt: DateTimeSchema,
});
export type JobAttempt = z.infer<typeof JobAttemptSchema>;

export const SnapshotSourceTypeSchema = z.enum([
  "repository-data",
  "connector",
  "manual-voc",
  "file-import",
  "agent-report",
]);
export const SnapshotSourceSchema = strictObject({
  type: SnapshotSourceTypeSchema,
  reference: z.string().trim().min(1).max(1_000),
  capturedAt: DateTimeSchema,
  checksum: Sha256Schema,
});
export type SnapshotSource = z.infer<typeof SnapshotSourceSchema>;

export const DataSnapshotSchema = strictObject({
  schemaVersion: SchemaVersionSchema,
  id: EntityIdSchema,
  runId: EntityIdSchema,
  marketplace: MarketplaceSchema,
  asins: AsinListSchema,
  dataCutoffAt: DateTimeSchema,
  sources: z.array(SnapshotSourceSchema).min(1),
  contentHash: Sha256Schema,
  createdAt: DateTimeSchema,
});
export type DataSnapshot = z.infer<typeof DataSnapshotSchema>;

export const SkillProvenanceSchema = strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: SchemaVersionSchema,
  contentHash: Sha256Schema,
});
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;

export const ModelProvenanceSchema = strictObject({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  responseId: z.string().trim().min(1).optional(),
});

export const InputSummarySchema = strictObject({
  contentHash: Sha256Schema,
  recordCount: z.number().int().min(0),
});

export const StructuredResultSchema = z.custom<Record<string, unknown>>(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  { error: "Expected a structured result object" },
);

export const AgentRunValidationStatusSchema = z.enum([
  "pending",
  "passed",
  "failed",
]);

const AgentRunSnapshotIdsSchema = z
  .array(EntityIdSchema)
  .min(1)
  .refine((snapshotIds) => new Set(snapshotIds).size === snapshotIds.length, {
    message: "Snapshot IDs must be unique",
  });

export const AgentRunV1Schema = strictObject({
  schemaVersion: z.literal("1.0.0"),
  id: EntityIdSchema,
  runId: EntityIdSchema,
  stage: StageNameSchema,
  status: RunStageStatusSchema,
  skill: SkillProvenanceSchema,
  snapshotIds: AgentRunSnapshotIdsSchema,
  model: ModelProvenanceSchema,
  inputSummary: InputSummarySchema,
  outputSchemaVersion: SchemaVersionSchema,
  output: StructuredResultSchema.nullable(),
  validationStatus: AgentRunValidationStatusSchema,
  error: ApiErrorSchema.nullable(),
  dataCutoffAt: DateTimeSchema,
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  durationMs: z.number().int().min(0).optional(),
  startedAt: DateTimeSchema,
  completedAt: DateTimeSchema.nullable(),
});

const SafeAccountingIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const AgentRunUsageCompletenessSchema = z.enum([
  "complete",
  "partial",
  "unavailable",
]);

export const AgentRunAttemptKindSchema = z.enum([
  "initial",
  "transient-retry",
  "format-repair",
]);

export const AgentRunAttemptAccountingSchema = z.enum([
  "settled",
  "projected",
  "unavailable",
]);

export const AgentRunAttemptErrorClassificationSchema = z.enum([
  "validation",
  "configuration",
  "authentication",
  "rate-limit",
  "upstream-temporary",
  "upstream-permanent",
  "data-quality",
  "model-output",
  "infrastructure",
  "cancelled",
  "unavailable",
]);

export const AgentRunAttemptSchema = strictObject({
  ordinal: z.number().int().min(0).max(3),
  kind: AgentRunAttemptKindSchema,
  transientRetryCount: z.number().int().min(0).max(2),
  formatRepair: z.boolean(),
  accounting: AgentRunAttemptAccountingSchema,
  errorClassification: AgentRunAttemptErrorClassificationSchema.nullable(),
}).superRefine((attempt, context) => {
  const identityIsConsistent =
    (attempt.kind === "initial" &&
      attempt.ordinal === 0 &&
      attempt.transientRetryCount === 0 &&
      !attempt.formatRepair) ||
    (attempt.kind === "format-repair" && attempt.formatRepair) ||
    (attempt.kind === "transient-retry" && attempt.transientRetryCount > 0);
  if (!identityIsConsistent) {
    context.addIssue({
      code: "custom",
      path: ["kind"],
      message: "AgentRun attempt identity is inconsistent",
    });
  }
});
export type AgentRunAttempt = z.infer<typeof AgentRunAttemptSchema>;

const WorkerErrorCategorySchema = z.enum([
  "validation",
  "configuration",
  "authentication",
  "rate-limit",
  "upstream-temporary",
  "upstream-permanent",
  "data-quality",
  "model-output",
  "infrastructure",
  "cancelled",
]);
const BudgetAuditValueSchema = z.number().nonnegative().finite();
export const AgentRunTerminalMetadataSchema = z.discriminatedUnion("kind", [
  strictObject({ kind: z.literal("succeeded") }),
  strictObject({
    kind: z.literal("budget-exceeded"),
    scope: z.enum(["call", "run", "daily"]),
    metric: z.enum(["tokens", "costUsd", "costMicros"]),
    used: BudgetAuditValueSchema,
    projected: BudgetAuditValueSchema,
    limit: BudgetAuditValueSchema,
  }).superRefine((metadata, context) => {
    if (
      metadata.metric !== "costUsd" &&
      ![metadata.used, metadata.projected, metadata.limit].every(Number.isSafeInteger)
    ) {
      context.addIssue({
        code: "custom",
        path: ["metric"],
        message: "Integer budget metrics require safe integer values",
      });
    }
  }),
  strictObject({ kind: z.literal("cancelled") }),
  strictObject({
    kind: z.literal("failed"),
    classification: WorkerErrorCategorySchema.exclude(["cancelled"]),
  }),
]);
export type AgentRunTerminalMetadata = z.infer<
  typeof AgentRunTerminalMetadataSchema
>;

export const AgentRunAuditSchema = strictObject({
  schemaVersion: z.literal("1.1.0"),
  id: EntityIdSchema,
  runId: EntityIdSchema,
  stageId: EntityIdSchema,
  jobAttemptId: EntityIdSchema,
  executionFingerprint: Sha256Schema,
  outputSchemaDigest: Sha256Schema,
  stage: StageNameSchema,
  status: RunStageStatusSchema,
  skill: SkillProvenanceSchema,
  snapshotIds: AgentRunSnapshotIdsSchema,
  model: ModelProvenanceSchema,
  inputSummary: InputSummarySchema,
  outputSchemaVersion: SchemaVersionSchema,
  output: StructuredResultSchema.nullable(),
  validationStatus: AgentRunValidationStatusSchema,
  error: ApiErrorSchema.nullable(),
  dataCutoffAt: DateTimeSchema,
  inputTokens: SafeAccountingIntegerSchema.nullable(),
  outputTokens: SafeAccountingIntegerSchema.nullable(),
  estimatedCostMicros: SafeAccountingIntegerSchema.nullable(),
  durationMs: SafeAccountingIntegerSchema.nullable(),
  attemptCount: z.number().int().min(0).max(4).nullable(),
  usageCompleteness: AgentRunUsageCompletenessSchema.nullable(),
  attempts: z.array(AgentRunAttemptSchema).max(4),
  terminalMetadata: AgentRunTerminalMetadataSchema.nullable(),
  startedAt: DateTimeSchema,
  completedAt: DateTimeSchema.nullable(),
}).superRefine((agentRun, context) => {
  if (
    agentRun.inputTokens !== null &&
    agentRun.outputTokens !== null &&
    !Number.isSafeInteger(agentRun.inputTokens + agentRun.outputTokens)
  ) {
    context.addIssue({
      code: "custom",
      path: ["outputTokens"],
      message: "Aggregate token usage must be a safe integer",
    });
  }

  const isPending = agentRun.validationStatus === "pending";
  const isPassed = agentRun.validationStatus === "passed";
  const pendingIsConsistent =
    agentRun.status === "running" &&
    agentRun.output === null &&
    agentRun.error === null &&
    agentRun.completedAt === null &&
    agentRun.inputTokens === null &&
    agentRun.outputTokens === null &&
    agentRun.estimatedCostMicros === null &&
    agentRun.durationMs === null &&
    agentRun.attemptCount === null &&
    agentRun.usageCompleteness === null &&
    agentRun.terminalMetadata === null &&
    agentRun.attempts.length === 0;
  const passedIsConsistent =
    agentRun.status === "succeeded" &&
    agentRun.output !== null &&
    agentRun.error === null &&
    agentRun.completedAt !== null &&
    agentRun.attemptCount !== null &&
    agentRun.attemptCount > 0 &&
    agentRun.usageCompleteness !== null &&
    agentRun.terminalMetadata?.kind === "succeeded";
  const failedIsConsistent =
    ["failed", "budget-exceeded", "cancelled"].includes(agentRun.status) &&
    agentRun.output === null &&
    agentRun.error !== null &&
    agentRun.completedAt !== null &&
    agentRun.attemptCount !== null &&
    agentRun.usageCompleteness !== null &&
    ((agentRun.status === "budget-exceeded" &&
      agentRun.terminalMetadata?.kind === "budget-exceeded") ||
      (agentRun.status === "cancelled" &&
        agentRun.terminalMetadata?.kind === "cancelled") ||
      (agentRun.status === "failed" &&
        agentRun.terminalMetadata?.kind === "failed"));

  if (
    (isPending && !pendingIsConsistent) ||
    (isPassed && !passedIsConsistent) ||
    (!isPending && !isPassed && !failedIsConsistent)
  ) {
    context.addIssue({
      code: "custom",
      path: ["validationStatus"],
      message: "AgentRun lifecycle fields are inconsistent",
    });
  }

  if (
    agentRun.attemptCount !== null &&
    agentRun.attemptCount !== agentRun.attempts.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["attemptCount"],
      message: "AgentRun attempt count must match its attempt trail",
    });
  }
  if (
    agentRun.attempts.some((attempt, index) => attempt.ordinal !== index)
  ) {
    context.addIssue({
      code: "custom",
      path: ["attempts"],
      message: "AgentRun attempts must use canonical ordinal order",
    });
  }

  const usageValuesAreKnown =
    agentRun.inputTokens !== null &&
    agentRun.outputTokens !== null &&
    agentRun.estimatedCostMicros !== null;
  const completeUsageIsConsistent =
    agentRun.usageCompleteness !== "complete" ||
    (usageValuesAreKnown &&
      agentRun.attempts.length > 0 &&
      agentRun.attempts.every((attempt) => attempt.accounting === "settled"));
  const partialUsageIsConsistent =
    agentRun.usageCompleteness !== "partial" ||
    (usageValuesAreKnown &&
      agentRun.attempts.some((attempt) => attempt.accounting === "projected") &&
      agentRun.attempts.every((attempt) => attempt.accounting !== "unavailable"));
  const unavailableUsageIsConsistent =
    agentRun.usageCompleteness !== "unavailable" ||
    (!usageValuesAreKnown &&
      agentRun.inputTokens === null &&
      agentRun.outputTokens === null &&
      agentRun.estimatedCostMicros === null);
  if (
    !completeUsageIsConsistent ||
    !partialUsageIsConsistent ||
    !unavailableUsageIsConsistent
  ) {
    context.addIssue({
      code: "custom",
      path: ["usageCompleteness"],
      message: "AgentRun usage completeness is inconsistent",
    });
  }

  if (
    agentRun.completedAt !== null &&
    Date.parse(agentRun.completedAt) < Date.parse(agentRun.startedAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["completedAt"],
      message: "AgentRun cannot complete before it starts",
    });
  }
});
export type AgentRunAudit = z.infer<typeof AgentRunAuditSchema>;

export const AgentRunSchema = z.discriminatedUnion("schemaVersion", [
  AgentRunV1Schema,
  AgentRunAuditSchema,
]);
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AnalysisReportStatusSchema = z.enum([
  "complete",
  "partial",
  "stale",
  "unavailable",
]);
export const EvidenceReferenceSchema = strictObject({
  id: z.string().trim().min(1).max(200),
  type: z.enum(["metric", "asin", "theme", "snapshot", "report"]),
  sourceId: z.string().trim().min(1).max(500),
  capturedAt: DateTimeSchema,
});
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const AnalysisReportSchema = strictObject({
  schemaVersion: SchemaVersionSchema,
  id: EntityIdSchema,
  runId: EntityIdSchema,
  agentRunId: EntityIdSchema,
  version: z.number().int().positive(),
  stage: StageNameSchema,
  status: AnalysisReportStatusSchema,
  skill: SkillProvenanceSchema,
  snapshotIds: z.array(EntityIdSchema).min(1),
  model: ModelProvenanceSchema,
  dataCutoffAt: DateTimeSchema,
  evidence: z.array(EvidenceReferenceSchema).min(1),
  result: StructuredResultSchema,
  createdAt: DateTimeSchema,
});
export type AnalysisReport<T extends Record<string, unknown> = Record<string, unknown>> = Omit<
  z.infer<typeof AnalysisReportSchema>,
  "result"
> & { result: T };

export const CapabilityStateSchema = strictObject({
  configured: z.boolean(),
  available: z.boolean(),
  reason: z.string().min(1).nullable(),
});
export const ConnectorIdSchema = z.enum(["sif", "sorftime", "sellerSprite"]);
export const ConnectorCapabilityStateSchema = CapabilityStateSchema.extend({
  checkedAt: DateTimeSchema.nullable(),
});
export const ConnectorHealthSchema = ConnectorCapabilityStateSchema.extend({
  connectorId: ConnectorIdSchema,
});
export type ConnectorHealthResponse = z.infer<typeof ConnectorHealthSchema>;
export const CapabilitiesResponseSchema = strictObject({
  schemaVersion: SchemaVersionSchema,
  capabilities: strictObject({
    storage: CapabilityStateSchema,
    openai: CapabilityStateSchema,
    sif: ConnectorCapabilityStateSchema,
    sorftime: ConnectorCapabilityStateSchema,
    sellerSprite: ConnectorCapabilityStateSchema,
    manualVoc: CapabilityStateSchema,
  }),
});
export type CapabilitiesResponse = z.infer<
  typeof CapabilitiesResponseSchema
>;

export const HealthResponseSchema = strictObject({
  status: z.literal("ok"),
  service: z.literal("agent-service"),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const LoginRequestSchema = strictObject({
  email: z.email(),
  password: z.string().min(1).max(1_024),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export const LoginResponseSchema = strictObject({ user: UserSchema });
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const LogoutRequestSchema = strictObject({});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;
export const LogoutResponseSchema = strictObject({ ok: z.literal(true) });
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

export const CreateProjectRequestSchema = strictObject({
  name: z.string().trim().min(1).max(200),
  marketplace: MarketplaceSchema,
  asins: AsinListSchema,
});
export type CreateProjectRequest = z.infer<
  typeof CreateProjectRequestSchema
>;
export const CreateProjectResponseSchema = strictObject({
  project: ProjectSchema,
});
export type CreateProjectResponse = z.infer<
  typeof CreateProjectResponseSchema
>;

export const ProjectIdParamsSchema = strictObject({
  projectId: EntityIdSchema,
});
export type ProjectIdParams = z.infer<typeof ProjectIdParamsSchema>;
export const GetProjectResponseSchema = strictObject({
  project: ProjectSchema,
});
export type GetProjectResponse = z.infer<typeof GetProjectResponseSchema>;

export const CreateRunRequestSchema = strictObject({
  mode: RunModeSchema,
  dataCutoffAt: DateTimeSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export const CreateRunResponseSchema = strictObject({
  run: AnalysisRunSchema,
  stages: z.array(RunStageSchema),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

export const RunIdParamsSchema = strictObject({ runId: EntityIdSchema });
export type RunIdParams = z.infer<typeof RunIdParamsSchema>;
export const GetRunResponseSchema = strictObject({
  run: AnalysisRunSchema,
  stages: z.array(RunStageSchema),
});
export type GetRunResponse = z.infer<typeof GetRunResponseSchema>;

export const CancelRunRequestSchema = strictObject({});
export type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;
export const CancelRunResponseSchema = strictObject({
  run: AnalysisRunSchema,
});
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;

export const RetryStageParamsSchema = strictObject({
  runId: EntityIdSchema,
  stage: StageNameSchema,
});
export type RetryStageParams = z.infer<typeof RetryStageParamsSchema>;
export const RetryStageRequestSchema = strictObject({});
export type RetryStageRequest = z.infer<typeof RetryStageRequestSchema>;
export const RetryStageResponseSchema = strictObject({
  stage: RunStageSchema,
  attempt: JobAttemptSchema,
});
export type RetryStageResponse = z.infer<typeof RetryStageResponseSchema>;

export const ListReportsResponseSchema = strictObject({
  reports: z.array(AnalysisReportSchema),
});
export type ListReportsResponse = z.infer<typeof ListReportsResponseSchema>;
export const ReportIdParamsSchema = strictObject({ reportId: EntityIdSchema });
export type ReportIdParams = z.infer<typeof ReportIdParamsSchema>;
export const GetReportResponseSchema = strictObject({
  report: AnalysisReportSchema,
});
export type GetReportResponse = z.infer<typeof GetReportResponseSchema>;

export const LocalVocSubmissionRequestSchema = strictObject({
  asins: AsinListSchema,
  marketplace: z.literal("US"),
});
export type LocalVocSubmissionRequest = z.infer<typeof LocalVocSubmissionRequestSchema>;
export const LocalVocSubmissionResponseSchema = strictObject({
  projectId: EntityIdSchema,
  runId: EntityIdSchema,
});
export type LocalVocSubmissionResponse = z.infer<typeof LocalVocSubmissionResponseSchema>;

export const LocalVocImportRequestSchema = strictObject({
  importMode: z.enum(["paste", "file-import"]),
  candidate: z.unknown(),
});
export type LocalVocImportRequest = z.infer<typeof LocalVocImportRequestSchema>;
export const LocalVocImportResponseSchema = strictObject({
  runId: EntityIdSchema,
  snapshotId: EntityIdSchema,
  stageId: EntityIdSchema,
  jobId: EntityIdSchema,
  importMode: z.enum(["paste", "file-import"]),
});
export type LocalVocImportResponse = z.infer<typeof LocalVocImportResponseSchema>;

export const LocalDataProjectKindSchema = z.enum([
  "analysis",
  "keyword-compare",
  "traffic-promo",
  "checklist",
]);
export const LocalDataProjectSchema = strictObject({
  id: z.string().trim().min(1).max(200),
  kind: LocalDataProjectKindSchema,
  slug: z.string().trim().min(1).max(200).nullable(),
  name: z.string().trim().min(1).max(200),
  majorCategory: z.string().trim().max(200).nullable(),
  categoryLabel: z.string().trim().max(200).nullable(),
  marketplace: MarketplaceSchema,
  asins: z.array(AsinSchema).min(3).max(10),
  note: z.string().trim().max(2000).nullable(),
  createdBy: z.string().trim().max(200).nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type LocalDataProject = z.infer<typeof LocalDataProjectSchema>;
const LocalDataProjectFieldsSchema = {
  kind: LocalDataProjectKindSchema.optional(),
  slug: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  alias: z.string().trim().min(1).max(200).optional(),
  majorCategory: z.string().trim().max(200).nullable().optional(),
  categoryLabel: z.string().trim().max(200).nullable().optional(),
  marketplace: MarketplaceSchema.optional(),
  asins: z.array(AsinSchema).min(3).max(10).optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  createdBy: z.string().trim().max(200).nullable().optional(),
};
export const LocalDataCreateProjectRequestSchema = strictObject({
  ...LocalDataProjectFieldsSchema,
  name: z.string().trim().min(1).max(200),
  asins: z.array(AsinSchema).min(3).max(10),
});
export const LocalDataUpdateProjectRequestSchema = strictObject(LocalDataProjectFieldsSchema)
  .refine((value) => Object.keys(value).length > 0, "Project update must contain a field");
export const LocalDataProjectIdParamsSchema = strictObject({ id: z.string().trim().min(1).max(200) });
export const LocalDataProjectListQuerySchema = strictObject({ kind: LocalDataProjectKindSchema.optional() });
export const LocalDataProjectsResponseSchema = strictObject({ projects: z.array(LocalDataProjectSchema) });
export const LocalDataProjectResponseSchema = strictObject({ project: LocalDataProjectSchema });
export const LocalDataDeleteProjectResponseSchema = strictObject({ ok: z.literal(true) });

const LocalDataAsinListSchema = z.array(AsinSchema).min(1).max(10).refine(
  (asins) => new Set(asins).size === asins.length,
  "ASINs must be unique",
);
export const LocalDataSyncStatusSchema = strictObject({
  asin: AsinSchema,
  inCatalog: z.boolean(),
  keywords: z.enum(["ready", "missing"]),
  reviews: z.enum(["ready", "missing"]),
  sales: z.enum(["ready", "missing"]),
  listing: z.enum(["ready", "missing"]),
  imageRemarks: z.enum(["ready", "missing"]),
  traffic: z.enum(["ready", "missing"]),
  voc: z.enum(["ready", "missing"]),
});
export const LocalDataSyncReadinessQuerySchema = strictObject({ asins: z.string().trim().min(1) });
export const LocalDataSyncStartRequestSchema = strictObject({
  asins: LocalDataAsinListSchema,
  marketplace: MarketplaceSchema.optional(),
});
export const LocalDataSyncReadinessResponseSchema = strictObject({
  asins: LocalDataAsinListSchema,
  items: z.array(LocalDataSyncStatusSchema),
  needsSync: z.boolean(),
  vocPending: LocalDataAsinListSchema.or(z.array(AsinSchema).length(0)),
  catalogPending: LocalDataAsinListSchema.or(z.array(AsinSchema).length(0)),
});
export const LocalDataSyncStageSchema = strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["auto", "manual"]),
  status: z.string().min(1),
  estimatedSeconds: z.number().finite().nonnegative(),
  detail: z.string().optional(),
  manualNote: z.string().optional(),
  startedAt: DateTimeSchema.nullable().optional(),
  completedAt: DateTimeSchema.nullable().optional(),
});
export const LocalDataSyncStartResponseSchema = strictObject({
  jobId: z.string().trim().min(1).max(200),
  status: z.string().min(1),
  message: z.string().min(1),
  mcpAsinsPending: z.array(AsinSchema),
  estimatedAutoSeconds: z.number().finite().nonnegative(),
  estimatedAlexaSeconds: z.number().finite().nonnegative(),
  stages: z.array(LocalDataSyncStageSchema),
});
export const LocalDataSyncJobIdParamsSchema = strictObject({ jobId: z.string().trim().min(1).max(200) });
export const LocalDataSyncJobSchema = z.object({
  jobId: z.string().trim().min(1).max(200),
  asins: z.array(AsinSchema),
  marketplace: MarketplaceSchema,
  status: z.string().min(1),
  message: z.string().min(1),
  currentStageId: z.string().min(1),
  stages: z.array(LocalDataSyncStageSchema),
  asinProgress: z.record(z.string(), z.record(z.string(), z.string())),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
}).passthrough();

export type ContractDefinition = Readonly<{
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  params?: z.ZodType;
  request?: z.ZodType;
  response: z.ZodType;
  error: typeof ApiErrorResponseSchema;
}>;

export const v1Contracts = [
  {
    method: "GET",
    path: "/health",
    response: HealthResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/capabilities",
    response: CapabilitiesResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/connectors/:connectorId/probe",
    response: ConnectorHealthSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/auth/login",
    request: LoginRequestSchema,
    response: LoginResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/auth/logout",
    request: LogoutRequestSchema,
    response: LogoutResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/projects",
    request: CreateProjectRequestSchema,
    response: CreateProjectResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/projects/:projectId",
    params: ProjectIdParamsSchema,
    response: GetProjectResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/projects/:projectId/runs",
    params: ProjectIdParamsSchema,
    request: CreateRunRequestSchema,
    response: CreateRunResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/runs/:runId",
    params: RunIdParamsSchema,
    response: GetRunResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/runs/:runId/cancel",
    params: RunIdParamsSchema,
    request: CancelRunRequestSchema,
    response: CancelRunResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/runs/:runId/stages/:stage/retry",
    params: RetryStageParamsSchema,
    request: RetryStageRequestSchema,
    response: RetryStageResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/runs/:runId/reports",
    params: RunIdParamsSchema,
    response: ListReportsResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/reports/:reportId",
    params: ReportIdParamsSchema,
    response: GetReportResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/local-voc",
    request: LocalVocSubmissionRequestSchema,
    response: LocalVocSubmissionResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/runs/:runId/voc-import",
    params: RunIdParamsSchema,
    request: LocalVocImportRequestSchema,
    response: LocalVocImportResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/local-data/projects",
    request: LocalDataProjectListQuerySchema,
    response: LocalDataProjectsResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/local-data/projects",
    request: LocalDataCreateProjectRequestSchema,
    response: LocalDataProjectResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/local-data/projects/:id",
    params: LocalDataProjectIdParamsSchema,
    response: LocalDataProjectResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "PATCH",
    path: "/v1/local-data/projects/:id",
    params: LocalDataProjectIdParamsSchema,
    request: LocalDataUpdateProjectRequestSchema,
    response: LocalDataProjectResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "DELETE",
    path: "/v1/local-data/projects/:id",
    params: LocalDataProjectIdParamsSchema,
    response: LocalDataDeleteProjectResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/local-data/sync-asins",
    request: LocalDataSyncReadinessQuerySchema,
    response: LocalDataSyncReadinessResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/local-data/sync-asins",
    request: LocalDataSyncStartRequestSchema,
    response: LocalDataSyncStartResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/local-data/sync-asins/:jobId",
    params: LocalDataSyncJobIdParamsSchema,
    response: LocalDataSyncJobSchema,
    error: ApiErrorResponseSchema,
  },
] as const satisfies readonly ContractDefinition[];

export type AgentServiceV1Path =
  | "/v1/capabilities"
  | "/v1/auth/login"
  | "/v1/auth/logout"
  | "/v1/projects"
  | `/v1/projects/${string}`
  | `/v1/projects/${string}/runs`
  | `/v1/runs/${string}`
  | `/v1/runs/${string}/cancel`
  | `/v1/runs/${string}/stages/${StageName}/retry`
  | `/v1/runs/${string}/reports`
  | `/v1/runs/${string}/voc-import`
  | `/v1/reports/${string}`
  | "/v1/local-voc"
  | "/v1/local-data/projects"
  | `/v1/local-data/projects/${string}`
  | "/v1/local-data/sync-asins"
  | `/v1/local-data/sync-asins/${string}`;

const uuidV4PathPattern =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const stagePathPattern =
  "(?:traffic-analysis|voc-positioning|product-definition)";

const compiledContracts = v1Contracts.map((contract) => {
  const escapedPath = contract.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escapedPath
    .replace(/:(?:projectId|runId|reportId)/g, uuidV4PathPattern)
    .replace(":connectorId", "(?:sif|sorftime|sellerSprite)")
    .replace(/:(?:id|jobId)/g, "[^/]+")
    .replace(":stage", stagePathPattern);
  return { contract, pattern: new RegExp(`^${pattern}$`) };
});

export function findHttpContract(
  method: string,
  path: string,
): ContractDefinition | undefined {
  return compiledContracts.find(
    ({ contract, pattern }) => contract.method === method && pattern.test(path),
  )?.contract;
}
