import { z } from "zod";

const strictObject = z.strictObject;

export const EntityIdSchema = z.uuidv4();
export const DateTimeSchema = z.iso.datetime({ offset: true });
export const SchemaVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "Expected a semantic schema version");
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
  requestId: z.string().min(1),
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
  checksum: z.string().regex(/^[a-f0-9]{64}$/i, "Expected SHA-256"),
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
  createdAt: DateTimeSchema,
});
export type DataSnapshot = z.infer<typeof DataSnapshotSchema>;

export const SkillProvenanceSchema = strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: SchemaVersionSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i, "Expected SHA-256"),
});
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;

export const ModelProvenanceSchema = strictObject({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  responseId: z.string().trim().min(1).optional(),
});

export const InputSummarySchema = strictObject({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i, "Expected SHA-256"),
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

export const AgentRunSchema = strictObject({
  schemaVersion: SchemaVersionSchema,
  id: EntityIdSchema,
  runId: EntityIdSchema,
  stage: StageNameSchema,
  status: RunStageStatusSchema,
  skill: SkillProvenanceSchema,
  snapshotIds: z.array(EntityIdSchema).min(1),
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
export const CapabilitiesResponseSchema = strictObject({
  schemaVersion: SchemaVersionSchema,
  capabilities: strictObject({
    storage: CapabilityStateSchema,
    openai: CapabilityStateSchema,
    sif: CapabilityStateSchema,
    sorftime: CapabilityStateSchema,
    sellerSprite: CapabilityStateSchema,
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

export type ContractDefinition = Readonly<{
  method: "GET" | "POST";
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
  | `/v1/reports/${string}`;

const uuidV4PathPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const stagePathPattern =
  "(?:traffic-analysis|voc-positioning|product-definition)";

const compiledContracts = v1Contracts.map((contract) => {
  const escapedPath = contract.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escapedPath
    .replace(/:(?:projectId|runId|reportId)/g, uuidV4PathPattern)
    .replace(":stage", stagePathPattern);
  return { contract, pattern: new RegExp(`^${pattern}$`, "i") };
});

export function findHttpContract(
  method: string,
  path: string,
): ContractDefinition | undefined {
  return compiledContracts.find(
    ({ contract, pattern }) => contract.method === method && pattern.test(path),
  )?.contract;
}
