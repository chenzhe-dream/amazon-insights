import { z } from "zod";

import {
  createAdminUserPresenceContracts,
} from "./admin-user-presence-contracts";

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
const adminUserPresenceContracts = createAdminUserPresenceContracts({
  DateTimeSchema,
  UserRoleSchema,
  UserStatusSchema,
});
export const {
  ActivityRequestSchema,
  ActivityResponseSchema,
  PresenceStatusSchema,
  InvalidationReasonSchema,
  AdminUserPresenceRecentLoginSchema,
  AdminUserPresenceUserSchema,
  AdminUserPresenceResponseSchema,
} = adminUserPresenceContracts;
export type ActivityRequest = z.infer<typeof ActivityRequestSchema>;
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;
export type InvalidationReason = z.infer<typeof InvalidationReasonSchema>;
export type AdminUserPresenceRecentLogin = z.infer<
  typeof AdminUserPresenceRecentLoginSchema
>;
export type AdminUserPresenceUser = z.infer<typeof AdminUserPresenceUserSchema>;
export type AdminUserPresenceResponse = z.infer<
  typeof AdminUserPresenceResponseSchema
>;
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
  marketplace: z.literal("US"),
  asins: AsinListSchema,
  createdBy: EntityIdSchema,
  currentRunId: EntityIdSchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const StageNameSchema = z.enum([
  "traffic-analysis",
  "alexa-voc-normalization",
  "voc-positioning",
  "product-definition",
]);
export type StageName = z.infer<typeof StageNameSchema>;

export const RunStageStatusSchema = z.enum([
  "queued",
  "running",
  "waiting-input",
  "succeeded",
  "partial",
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
  "QUEUE_TIMEOUT",
  "VALIDATION_ERROR",
  "ALEXA_VOC_ASIN_MISMATCH",
  "CONFIGURATION_ERROR",
  "AUTHENTICATION_REQUIRED",
  "INVALID_CREDENTIALS",
  "LOGIN_RATE_LIMITED",
  "DINGTALK_INVALID_STATE",
  "DINGTALK_INVALID_CODE",
  "DINGTALK_NOT_MEMBER",
  "DINGTALK_DISABLED",
  "DINGTALK_UNAVAILABLE",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "IMMUTABLE_SCOPE",
  "IDEMPOTENCY_KEY_REUSED",
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

export const ModelProviderReasonCodeSchema = z.enum([
  "HTTP_REQUEST_REJECTED",
  "HTTP_AUTHENTICATION",
  "HTTP_RATE_LIMITED",
  "HTTP_UPSTREAM_UNAVAILABLE",
]);
export type ModelProviderReasonCode = z.infer<
  typeof ModelProviderReasonCodeSchema
>;

export const AgentRunAttemptSchema = strictObject({
  ordinal: z.number().int().min(0).max(3),
  kind: AgentRunAttemptKindSchema,
  transientRetryCount: z.number().int().min(0).max(2),
  formatRepair: z.boolean(),
  accounting: AgentRunAttemptAccountingSchema,
  errorClassification: AgentRunAttemptErrorClassificationSchema.nullable(),
  providerReasonCode: ModelProviderReasonCodeSchema.optional(),
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
export const ConnectorCredentialRequestSchema = strictObject({
  secret: z.string().min(1).refine(
    (value) => new TextEncoder().encode(value).byteLength <= 8_192,
    "Connector credential must be at most 8192 UTF-8 bytes",
  ),
  confirmEnvironmentReplacement: z.literal(true).optional(),
});
export const ConnectorCredentialStateSchema = strictObject({
  connectorId: ConnectorIdSchema,
  configured: z.boolean(),
  managed: z.boolean(),
  source: z.enum(["managed", "environment", "none"]),
  version: z.number().int().positive().nullable(),
  updatedAt: DateTimeSchema.nullable(),
});
export const ConnectorCredentialListSchema = strictObject({
  connectors: z.array(ConnectorCredentialStateSchema).length(3),
});
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
export const AgentReadinessResponseSchema = strictObject({
  schemaVersion: SchemaVersionSchema,
  readiness: strictObject({
    storage: z.boolean(),
    openai: z.boolean(),
  }),
});
export type AgentReadinessResponse = z.infer<
  typeof AgentReadinessResponseSchema
>;

const ConcurrencyProfileSchema = z.enum(["conservative", "standard", "fast"]);
const ConcurrencyLimitsSchema = strictObject({
  wholeJob: z.number().int().positive(),
  sellerSprite: z.number().int().positive(),
  sif: z.number().int().positive(),
  sorftime: z.number().int().positive(),
  model: z.number().int().positive(),
  image: z.number().int().positive(),
});
export const ConcurrencyPolicySchema = strictObject({
  version: z.string().trim().min(1).max(100),
  profile: ConcurrencyProfileSchema,
  limits: ConcurrencyLimitsSchema,
  sellerSpriteRolling: strictObject({
    maxAttempts: z.number().int().positive(),
    windowMs: z.number().int().positive(),
  }),
});
export const ConcurrencyResourceCircuitSchema = strictObject({
  paused: z.boolean(),
  manualHold: z.boolean(),
  reason: z.enum([
    "manual-hold",
    "quota-exhausted",
    "upstream-error",
    "rate-limited",
  ]).nullable(),
  updatedAt: DateTimeSchema.nullable(),
});
export const ConcurrencyConnectorAdminStateSchema =
  ConnectorCapabilityStateSchema.extend({
    circuit: ConcurrencyResourceCircuitSchema,
  });
export const SellerSpriteQuotaAdminStateSchema = strictObject({
  total: z.number().int().nonnegative().nullable(),
  totalLabel: z.string().trim().min(1).max(50),
  remaining: z.number().int().nonnegative().nullable(),
  used: z.number().int().nonnegative().nullable(),
  localObservedAttempts: z.number().int().nonnegative(),
  source: z.enum(["provider", "configured", "local-observed", "unknown"]),
  status: z.enum(["unknown", "ok", "warning", "conservative", "paused", "error"]),
  checkedAt: DateTimeSchema.nullable(),
  ageSeconds: z.number().int().nonnegative().nullable(),
  warning: z.string().trim().min(1).max(200).nullable(),
});
export const ConcurrencyAdminResponseSchema = strictObject({
  schemaVersion: SchemaVersionSchema,
  organizationId: z.string().trim().min(1).max(200),
  queue: strictObject({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    terminal: z.number().int().nonnegative(),
  }),
  policy: ConcurrencyPolicySchema,
  connectors: strictObject({
    sellerSprite: ConcurrencyConnectorAdminStateSchema,
    sif: ConcurrencyConnectorAdminStateSchema,
    sorftime: ConcurrencyConnectorAdminStateSchema,
  }),
  sellerSpriteQuota: SellerSpriteQuotaAdminStateSchema,
});
export type ConcurrencyAdminResponse = z.infer<
  typeof ConcurrencyAdminResponseSchema
>;
export const ConcurrencyPolicyUpdateRequestSchema = strictObject({
  profile: ConcurrencyProfileSchema,
});
export const SellerSpriteQuotaTotalRequestSchema = strictObject({
  total: z.number().int().positive().nullable(),
});
export const ConcurrencyPauseRequestSchema = strictObject({
  resource: z.literal("sellerSprite"),
  paused: z.boolean(),
});
export const ConnectorCircuitResetParamsSchema = strictObject({
  connectorId: ConnectorIdSchema,
});

export const HealthResponseSchema = strictObject({
  status: z.literal("ok"),
  service: z.literal("agent-service"),
  codeSource: strictObject({
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const LoginRequestSchema = strictObject({
  email: z.email(),
  password: z.string().min(8).max(1_024),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export const LoginResponseSchema = strictObject({ user: UserSchema });
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const DingTalkPublicConfigResponseSchema = z.discriminatedUnion(
  "enabled",
  [
    strictObject({ enabled: z.literal(false) }),
    strictObject({
      enabled: z.literal(true),
      clientId: z.string().trim().min(1).max(200),
      corpId: z.string().trim().min(1).max(200),
      agentId: z.string().trim().min(1).max(200),
    }),
  ],
);
export type DingTalkPublicConfigResponse = z.infer<
  typeof DingTalkPublicConfigResponseSchema
>;

export const DingTalkWorkbenchLoginRequestSchema = strictObject({
  code: z.string().trim().min(1).max(2_000),
});
export type DingTalkWorkbenchLoginRequest = z.infer<
  typeof DingTalkWorkbenchLoginRequestSchema
>;
export const DingTalkWorkbenchLoginResponseSchema = LoginResponseSchema;
export type DingTalkWorkbenchLoginResponse = z.infer<
  typeof DingTalkWorkbenchLoginResponseSchema
>;

export const DingTalkOAuthStartRequestSchema = strictObject({
  returnPath: z.string().trim().min(1).max(2_000),
});
export type DingTalkOAuthStartRequest = z.infer<
  typeof DingTalkOAuthStartRequestSchema
>;
export const DingTalkOAuthStartResponseSchema = strictObject({
  authorizationUrl: z.url(),
  expiresAt: DateTimeSchema,
});
export type DingTalkOAuthStartResponse = z.infer<
  typeof DingTalkOAuthStartResponseSchema
>;

export const DingTalkOAuthCallbackRequestSchema = strictObject({
  code: z.string().trim().min(1).max(2_000),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type DingTalkOAuthCallbackRequest = z.infer<
  typeof DingTalkOAuthCallbackRequestSchema
>;
export const DingTalkOAuthCallbackResponseSchema = strictObject({
  user: UserSchema,
  returnPath: z.string().trim().min(1).max(2_000),
});
export type DingTalkOAuthCallbackResponse = z.infer<
  typeof DingTalkOAuthCallbackResponseSchema
>;

export const LogoutRequestSchema = strictObject({});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;
export const LogoutResponseSchema = strictObject({ ok: z.literal(true) });
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

const SessionIdentitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const SessionResponseSchema = z.discriminatedUnion("authenticated", [
  strictObject({
    authenticated: z.literal(true),
    user: UserSchema,
    sessionIdentity: SessionIdentitySchema,
    canViewUserPresence: z.boolean().default(false),
  }),
  strictObject({ authenticated: z.literal(false), user: z.null(), sessionIdentity: z.null() }),
]);
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const ChangePasswordRequestSchema = strictObject({
  currentPassword: z.string().min(8).max(1_024),
  newPassword: z.string().min(8).max(1_024),
  confirmation: z.string().min(8).max(1_024),
}).refine((value) => value.newPassword === value.confirmation, {
  path: ["confirmation"],
  message: "Password confirmation does not match",
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
export const ChangePasswordResponseSchema = strictObject({ ok: z.literal(true) });
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponseSchema>;

export const FeedbackCategorySchema = z.enum(["bug", "suggestion", "other"]);
export const MAX_FEEDBACK_IMAGES = 3;
export const MAX_FEEDBACK_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FEEDBACK_MULTIPART_BYTES =
  MAX_FEEDBACK_IMAGES * MAX_FEEDBACK_IMAGE_BYTES + 128 * 1024;
export const MAX_FEEDBACK_TRANSFER_BYTES =
  MAX_FEEDBACK_IMAGES * Math.ceil(MAX_FEEDBACK_IMAGE_BYTES / 3) * 4 +
  128 * 1024;
export const CreateFeedbackRequestSchema = strictObject({
  category: FeedbackCategorySchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4_000),
  pagePath: z.string().trim().min(1).max(2_000),
});
export type CreateFeedbackRequest = z.infer<typeof CreateFeedbackRequestSchema>;
const FeedbackTransferImageSchema = strictObject({
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  byteLength: z.number().int().min(1).max(MAX_FEEDBACK_IMAGE_BYTES),
  contentBase64: z.string()
    .min(4)
    .max(4 * Math.ceil(MAX_FEEDBACK_IMAGE_BYTES / 3)),
}).refine(
  ({ byteLength, contentBase64 }) => {
    if (
      contentBase64.length % 4 !== 0 ||
      contentBase64.length > 4 * Math.ceil(MAX_FEEDBACK_IMAGE_BYTES / 3)
    ) {
      return false;
    }
    const padding = contentBase64.endsWith("==")
      ? 2
      : contentBase64.endsWith("=")
        ? 1
        : 0;
    const unpaddedLength = contentBase64.length - padding;
    for (let index = 0; index < unpaddedLength; index += 1) {
      const code = contentBase64.charCodeAt(index);
      const base64Character =
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        code === 43 ||
        code === 47;
      if (!base64Character) return false;
    }
    for (let index = unpaddedLength; index < contentBase64.length; index += 1) {
      if (contentBase64.charCodeAt(index) !== 61) return false;
    }
    return (contentBase64.length / 4) * 3 - padding === byteLength;
  },
  { message: "Encoded image length does not match byteLength" },
);
export const CreateFeedbackTransferRequestSchema =
  CreateFeedbackRequestSchema.extend({
    images: z.array(FeedbackTransferImageSchema).max(MAX_FEEDBACK_IMAGES),
  });
export type CreateFeedbackTransferRequest = z.infer<
  typeof CreateFeedbackTransferRequestSchema
>;
export const CreateFeedbackResponseSchema = strictObject({
  feedbackId: EntityIdSchema,
  createdAt: DateTimeSchema,
});
export type CreateFeedbackResponse = z.infer<typeof CreateFeedbackResponseSchema>;

export const FeedbackStatusSchema = z.enum([
  "new",
  "processing",
  "resolved",
  "closed",
]);
export type FeedbackStatus = z.infer<typeof FeedbackStatusSchema>;

export const FeedbackAttachmentMetadataSchema = strictObject({
  id: EntityIdSchema,
  feedbackId: EntityIdSchema,
  fileName: z.string().min(1).max(255),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  byteSize: z.number().int().min(1).max(5 * 1024 * 1024),
  sha256: Sha256Schema,
  createdAt: DateTimeSchema,
});
export type FeedbackAttachmentMetadata = z.infer<
  typeof FeedbackAttachmentMetadataSchema
>;

export const FeedbackStatusEventSchema = strictObject({
  id: EntityIdSchema,
  feedbackId: EntityIdSchema,
  actorUserId: EntityIdSchema,
  eventType: z.enum(["created", "status_changed"]),
  fromStatus: FeedbackStatusSchema.nullable(),
  toStatus: FeedbackStatusSchema,
  createdAt: DateTimeSchema,
});
export type FeedbackStatusEvent = z.infer<typeof FeedbackStatusEventSchema>;

export const FeedbackListItemSchema = strictObject({
  id: EntityIdSchema,
  organizationId: EntityIdSchema,
  actorUserId: EntityIdSchema,
  category: FeedbackCategorySchema,
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4_000),
  pagePath: z.string().min(1).max(1_000),
  appVersion: z.string().min(1).max(100).nullable(),
  createdAt: DateTimeSchema,
  status: FeedbackStatusSchema,
  workflowVersion: z.number().int().min(1),
  adminSeenAt: DateTimeSchema.nullable(),
  attachmentCount: z.number().int().min(0).max(3),
});
export type FeedbackListItem = z.infer<typeof FeedbackListItemSchema>;

export const FeedbackDetailSchema = FeedbackListItemSchema.extend({
  attachments: z.array(FeedbackAttachmentMetadataSchema).max(3),
  events: z.array(FeedbackStatusEventSchema),
}).strict();
export type FeedbackDetail = z.infer<typeof FeedbackDetailSchema>;

export const FeedbackListResponseSchema = strictObject({
  feedback: z.array(FeedbackListItemSchema),
});
export type FeedbackListResponse = z.infer<typeof FeedbackListResponseSchema>;
export const FeedbackDetailResponseSchema = strictObject({
  feedback: FeedbackDetailSchema,
});
export type FeedbackDetailResponse = z.infer<
  typeof FeedbackDetailResponseSchema
>;
export const FeedbackIdParamsSchema = strictObject({
  feedbackId: EntityIdSchema,
});
export const FeedbackAttachmentParamsSchema = strictObject({
  feedbackId: EntityIdSchema,
  attachmentId: EntityIdSchema,
});
export const FeedbackAdminListQuerySchema = strictObject({
  status: FeedbackStatusSchema.optional(),
});
export const FeedbackUnreadCountResponseSchema = strictObject({
  count: z.number().int().nonnegative(),
});
export const MarkFeedbackSeenRequestSchema = strictObject({});
export const MarkFeedbackSeenResponseSchema = strictObject({
  seen: z.boolean(),
});
export const ChangeFeedbackStatusRequestSchema = strictObject({
  status: FeedbackStatusSchema,
  expectedVersion: z.number().int().min(1),
});

export const CreateProjectRequestSchema = strictObject({
  id: EntityIdSchema.optional(),
  name: z.string().trim().min(1).max(200),
  marketplace: z.literal("US"),
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
export const ProjectCreationIdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "Invalid project creation idempotency key");
export const ListProjectsResponseSchema = strictObject({
  projects: z.array(ProjectSchema),
});
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;
export const UpdateProjectRequestSchema = strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  marketplace: z.literal("US").optional(),
  asins: AsinListSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "Project update must contain a field");
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;
export const UpdateProjectResponseSchema = strictObject({
  project: ProjectSchema,
});
export type UpdateProjectResponse = z.infer<typeof UpdateProjectResponseSchema>;

export const ProjectIdParamsSchema = strictObject({
  projectId: EntityIdSchema,
});
export type ProjectIdParams = z.infer<typeof ProjectIdParamsSchema>;
export const GetProjectResponseSchema = strictObject({
  project: ProjectSchema,
});
export type GetProjectResponse = z.infer<typeof GetProjectResponseSchema>;

export const LegacyProjectIdParamsSchema = strictObject({
  legacyProjectId: EntityIdSchema,
});
export const LegacyProjectEligibilityResponseSchema = strictObject({
  legacyProjectId: EntityIdSchema,
  readOnly: z.literal(true),
  importAllowed: z.literal(true),
});
export type LegacyProjectEligibilityResponse = z.infer<
  typeof LegacyProjectEligibilityResponseSchema
>;

export const CreateRunRequestSchema = strictObject({
  mode: RunModeSchema,
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

const NonEmptyManualAlexaVocTextSchema = z.string().trim().min(1).max(16_384);
const DecimalStringSchema = z.string().regex(/^[1-9]\d*$/);

export const MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT = "这个产品的顾客关注点是什么，好评点是什么，差评点是什么，未被满足的需求是什么，使用人群是谁，使用场景是什么，核心购买动机是什么。";
export const ManualAlexaVocReportHeaderSchema = strictObject({
  title: NonEmptyManualAlexaVocTextSchema,
  asin: AsinSchema,
  rating: z.number().min(0).max(5),
  reviewCount: z.number().int().nonnegative(),
  starBreakdown: NonEmptyManualAlexaVocTextSchema.optional(),
  prompt: NonEmptyManualAlexaVocTextSchema,
  overallConclusion: NonEmptyManualAlexaVocTextSchema,
  captureNote: NonEmptyManualAlexaVocTextSchema.optional(),
  captureStatus: z.literal("dialog").optional(),
});
export type ManualAlexaVocReportHeader = z.infer<typeof ManualAlexaVocReportHeaderSchema>;

export const ManualAlexaVocNormalizedRecordSchema = strictObject({
  asin: AsinSchema,
  attention: z.array(NonEmptyManualAlexaVocTextSchema).max(256),
  positives: z.array(NonEmptyManualAlexaVocTextSchema).max(256),
  negatives: z.array(NonEmptyManualAlexaVocTextSchema).max(256),
  unmet: z.array(NonEmptyManualAlexaVocTextSchema).max(256),
  audiences: z.array(NonEmptyManualAlexaVocTextSchema).max(256),
  scenarios: z.array(NonEmptyManualAlexaVocTextSchema).max(256),
  motives: z.array(NonEmptyManualAlexaVocTextSchema).max(256),
  captureStatus: z.literal("dialog"),
  alexaReport: ManualAlexaVocReportHeaderSchema,
}).refine((record) => record.alexaReport.asin === record.asin, {
  message: "Alexa report ASIN must match its record",
  path: ["alexaReport", "asin"],
});
export type ManualAlexaVocNormalizedRecord = z.infer<typeof ManualAlexaVocNormalizedRecordSchema>;

const RawManualAlexaVocImportSchema = strictObject({
  projectId: EntityIdSchema,
  runId: EntityIdSchema,
  asin: AsinSchema,
  marketplace: z.literal("US"),
  text: z.string().optional(),
  rawText: z.string().optional(),
}).superRefine((value, context) => {
  if ((value.text === undefined) === (value.rawText === undefined)) {
    context.addIssue({ code: "custom", message: "exactly one of text or rawText is required" });
  }
});
export const ManualAlexaVocImportRequestSchema = RawManualAlexaVocImportSchema.transform(
  ({ text, rawText, ...scope }) => ({ ...scope, rawText: rawText ?? text! }),
);
export type ManualAlexaVocImportRequest = z.infer<typeof ManualAlexaVocImportRequestSchema>;

export const ManualAlexaVocRecordSchema = strictObject({
  asin: AsinSchema,
  marketplace: z.literal("US"),
  revision: DecimalStringSchema,
  contentHash: Sha256Schema,
  normalizedRecord: ManualAlexaVocNormalizedRecordSchema,
  source: z.enum(["postgres", "legacy-static-stale"]),
  generation: DecimalStringSchema.nullable(),
  capturedAt: DateTimeSchema,
});
export type ManualAlexaVocRecord = z.infer<typeof ManualAlexaVocRecordSchema>;
export const AlexaVocNormalizationStatusSchema = strictObject({
  asin: AsinSchema,
  fingerprint: Sha256Schema,
  status: z.enum(["pending", "success", "failure"]),
  revision: DecimalStringSchema.nullable(),
  error: z.enum(["model-output", "schema", "persistence", "authorization"]).nullable(),
}).superRefine((value, context) => {
  if (value.status === "success" && value.revision === null) {
    context.addIssue({ code: "custom", path: ["revision"], message: "success requires a revision" });
  }
  if (value.status !== "success" && value.revision !== null) {
    context.addIssue({ code: "custom", path: ["revision"], message: "non-success status cannot expose a revision" });
  }
  if (value.status === "failure" && value.error === null) {
    context.addIssue({ code: "custom", path: ["error"], message: "failure requires a safe error category" });
  }
  if (value.status !== "failure" && value.error !== null) {
    context.addIssue({ code: "custom", path: ["error"], message: "non-failure status cannot expose an error" });
  }
});
export type AlexaVocNormalizationStatus = z.infer<typeof AlexaVocNormalizationStatusSchema>;
export const AlexaVocNormalizationStatusQuerySchema = strictObject({
  projectId: EntityIdSchema,
  runId: EntityIdSchema,
  marketplace: z.literal("US"),
  asins: z.array(AsinSchema).min(1).max(10).refine((asins) => new Set(asins).size === asins.length, {
    message: "ASINs must be unique",
  }),
});
export type AlexaVocNormalizationStatusQuery = z.infer<typeof AlexaVocNormalizationStatusQuerySchema>;
export const AlexaVocNormalizationStatusResponseSchema = strictObject({
  records: z.array(AlexaVocNormalizationStatusSchema).max(10),
});
export type AlexaVocNormalizationStatusResponse = z.infer<typeof AlexaVocNormalizationStatusResponseSchema>;
export const ManualAlexaVocWriteResponseSchema = strictObject({
  disposition: z.enum(["success", "pending"]),
  record: ManualAlexaVocRecordSchema.nullable(),
  normalization: AlexaVocNormalizationStatusSchema,
}).superRefine((value, context) => {
  if (value.disposition === "success" && value.record === null) {
    context.addIssue({ code: "custom", path: ["record"], message: "success requires a record" });
  }
  if (value.disposition === "pending" && value.record !== null) {
    context.addIssue({ code: "custom", path: ["record"], message: "pending cannot expose a record" });
  }
});
export type ManualAlexaVocWriteResponse = z.infer<typeof ManualAlexaVocWriteResponseSchema>;
export const ManualAlexaVocListQuerySchema = strictObject({
  projectId: EntityIdSchema,
  marketplace: z.literal("US"),
  asins: z.array(AsinSchema).min(1).max(10).refine((asins) => new Set(asins).size === asins.length, {
    message: "ASINs must be unique",
  }),
});
export type ManualAlexaVocListQuery = z.infer<typeof ManualAlexaVocListQuerySchema>;
export const ManualAlexaVocListResponseSchema = strictObject({ records: z.array(ManualAlexaVocRecordSchema).max(10) });
export type ManualAlexaVocListResponse = z.infer<typeof ManualAlexaVocListResponseSchema>;

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

const LocalDataAsinListSchema = z.array(AsinSchema).min(1).max(10);
export const LocalDataSyncStatusSchema = strictObject({
  asin: AsinSchema,
  inCatalog: z.boolean(),
  keywords: z.enum(["ready", "missing"]),
  reviews: z.enum(["ready", "missing"]),
  sales: z.enum(["ready", "missing"]),
  childSales: z.enum(["ready", "missing"]),
  priceStrategy: z.enum(["ready", "missing"]),
  fba: z.enum(["ready", "missing"]),
  listing: z.enum(["ready", "missing"]),
  imageRemarks: z.enum(["ready", "missing"]),
  category: z.enum(["ready", "missing"]),
  traffic: z.enum(["ready", "missing"]),
  voc: z.enum(["ready", "missing"]),
});
export const LocalDataSyncReadinessQuerySchema = strictObject({ asins: z.string().trim().min(1) });
export const LocalDataSyncStartRequestSchema = strictObject({
  asins: LocalDataAsinListSchema,
  marketplace: MarketplaceSchema.optional(),
  projectId: EntityIdSchema.optional(),
  runId: EntityIdSchema.optional(),
});
export const LocalDataSyncReadinessResponseSchema = strictObject({
  asins: LocalDataAsinListSchema,
  items: z.array(LocalDataSyncStatusSchema),
  needsSync: z.boolean(),
  vocPending: LocalDataAsinListSchema.or(z.array(AsinSchema).length(0)),
  catalogPending: LocalDataAsinListSchema.or(z.array(AsinSchema).length(0)),
});
const CatalogProviderConnectorIdSchema = z.enum(["sellerSprite", "sorftime"]);
const LocalDataCatalogProviderPlanSchema = strictObject({
  preferredConnectorId: CatalogProviderConnectorIdSchema,
  unavailableConnectorIds: z.array(CatalogProviderConnectorIdSchema)
    .max(1)
    .refine((connectorIds) => new Set(connectorIds).size === connectorIds.length, {
      message: "Catalog unavailable connectors must be unique",
    }),
}).refine((plan) => !plan.unavailableConnectorIds.includes(plan.preferredConnectorId), {
  message: "Preferred catalog connector cannot be unavailable",
}).refine(
  (plan) => plan.preferredConnectorId !== "sorftime"
    || plan.unavailableConnectorIds.includes("sellerSprite"),
  { message: "Sorftime is preferred only when SellerSprite is unavailable" },
);
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
  catalogProviderPlan: LocalDataCatalogProviderPlanSchema.optional(),
}).refine((stage) => stage.catalogProviderPlan === undefined || stage.id === "catalog", {
  message: "Catalog provider plan is only valid on the catalog stage",
});
export const LocalDataSyncStartResponseSchema = strictObject({
  jobId: z.string().trim().min(1).max(200),
  status: z.string().min(1),
  message: z.string().min(1),
  mcpAsinsPending: z.array(AsinSchema),
  estimatedAutoSeconds: z.number().finite().nonnegative(),
  estimatedAlexaSeconds: z.number().finite().nonnegative(),
  stages: z.array(LocalDataSyncStageSchema),
  reused: z.boolean(),
  scope: strictObject({
    projectId: EntityIdSchema.nullable(),
    runId: EntityIdSchema.nullable(),
  }),
});
export const LocalDataSyncJobIdParamsSchema = strictObject({ jobId: z.string().trim().min(1).max(200) });
export const ProjectableSyncStageSchema = z.enum([
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
  "child_sales", "price_strategy", "image_remarks",
]);
export type ProjectableSyncStage = z.infer<typeof ProjectableSyncStageSchema>;

const StageOutputGapReasonCodeSchema = z.enum(["CONNECT_TIMEOUT", "UPSTREAM_EMPTY", "CONNECTOR_FAILED", "SIF_KEYWORD_SCHEMA_INVALID", "MCP_SCHEMA"]);
const StageOutputGapShapeSchema = strictObject({
  topLevelType: z.enum(["unknown", "null", "array", "object", "string", "number", "boolean"]),
  data: strictObject({ presence: z.enum(["unknown", "missing", "present"]), type: z.enum(["unknown", "null", "array", "object", "string", "number", "boolean"]) }),
  details: strictObject({ presence: z.enum(["unknown", "missing", "present"]), type: z.enum(["unknown", "null", "array", "object", "string", "number", "boolean"]) }),
  items: strictObject({ presence: z.enum(["unknown", "missing", "present"]), type: z.enum(["unknown", "null", "array", "object", "string", "number", "boolean"]) }),
});
const StageOutputGapItemSchema = strictObject({
  asin: AsinSchema,
  causeCode: StageOutputGapReasonCodeSchema,
  operation: z.enum(["tools/list", "asin_detail", "asin_sales_trend", "keepa_info", "review", "product_customers_say", "product_reviews", "product_detail", "product_trend", "product_variations", "category_name_search", "category_trend"]).optional(),
  boundary: z.enum(["response-body", "rpc-envelope", "tool-content", "consumer-shape"]).optional(),
  shape: StageOutputGapShapeSchema.optional(),
});
export const StageOutputGapSchema = strictObject({
  state: z.enum(["partial", "failed"]),
  reasonCode: StageOutputGapReasonCodeSchema,
  items: z.array(StageOutputGapItemSchema).max(32).optional(),
});

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));
const JsonMapSchema = z.record(z.string(), JsonValueSchema);
const StageDataSchemas = {
  keywords: strictObject({ analysisByAsin: JsonMapSchema, enrichmentByKeyword: JsonMapSchema }),
  reviews: strictObject({ analysisByAsin: JsonMapSchema, ratingByAsin: JsonMapSchema }),
  sales_trend: strictObject({ trendByAsin: JsonMapSchema }),
  fba: strictObject({ feeByAsin: JsonMapSchema }),
  listing: strictObject({ contentByAsin: JsonMapSchema }),
  category: strictObject({ trendByNode: JsonMapSchema }),
  traffic: strictObject({ listingByAsin: JsonMapSchema, monthlyByAsin: JsonMapSchema }),
  child_sales: strictObject({ rowsByAsin: JsonMapSchema }),
  price_strategy: strictObject({ strategyByAsin: JsonMapSchema }),
  image_remarks: strictObject({ remarksByAsin: JsonMapSchema, outcomesByAsin: JsonMapSchema }),
} as const;
const ProjectionBase = {
  jobId: z.string().min(1).max(200), projectId: EntityIdSchema, runId: EntityIdSchema,
  jobVersion: z.number().int().positive(), outputVersion: z.number().int().positive(),
  contentHash: Sha256Schema, updatedAt: DateTimeSchema,
};
const dataProjection = <S extends ProjectableSyncStage>(stage: S) => strictObject({
  ...ProjectionBase, stage: z.literal(stage), stageStatus: z.literal("done"), data: StageDataSchemas[stage],
});
const failedProjection = <S extends ProjectableSyncStage>(stage: S) => strictObject({
  ...ProjectionBase, stage: z.literal(stage), stageStatus: z.literal("failed"),
  gap: StageOutputGapSchema.extend({ state: z.literal("failed") }),
});
const partialProjection = <S extends ProjectableSyncStage>(stage: S) => strictObject({
  ...ProjectionBase, stage: z.literal(stage), stageStatus: z.literal("partial"),
  data: StageDataSchemas[stage], gap: StageOutputGapSchema.extend({ state: z.literal("partial") }),
});
export const LocalDataStageOutputResponseSchema = z.union([
  dataProjection("keywords"), partialProjection("keywords"), failedProjection("keywords"),
  dataProjection("reviews"), partialProjection("reviews"), failedProjection("reviews"),
  dataProjection("sales_trend"), partialProjection("sales_trend"), failedProjection("sales_trend"),
  dataProjection("fba"), partialProjection("fba"), failedProjection("fba"),
  dataProjection("listing"), partialProjection("listing"), failedProjection("listing"),
  dataProjection("category"), partialProjection("category"), failedProjection("category"),
  dataProjection("traffic"), partialProjection("traffic"), failedProjection("traffic"),
  dataProjection("child_sales"), partialProjection("child_sales"), failedProjection("child_sales"),
  dataProjection("price_strategy"), partialProjection("price_strategy"), failedProjection("price_strategy"),
  dataProjection("image_remarks"), partialProjection("image_remarks"), failedProjection("image_remarks"),
]);
export type StageOutputProjection = z.infer<typeof LocalDataStageOutputResponseSchema>;
type WithoutStageOutputMetadata<T> = T extends unknown ? Omit<T, keyof typeof ProjectionBase> : never;
export type StageOutputDraft = WithoutStageOutputMetadata<StageOutputProjection>;

export const LocalDataStageOutputParamsSchema = strictObject({
  projectId: EntityIdSchema, runId: EntityIdSchema,
  jobId: z.string().trim().min(1).max(200), stage: ProjectableSyncStageSchema,
});
export const LocalDataSyncModuleResultSchema = strictObject({
  status: z.enum(["ready", "upstream-empty", "timeout", "connector-failed", "pending", "manual"]),
  reason: z.string().trim().min(1).max(240).nullable(),
  updatedAt: DateTimeSchema,
});
export const LocalDataSyncAlexaVocSchema = strictObject({
  pendingAsins: z.array(AsinSchema),
  estimatedSeconds: z.number().finite().nonnegative(),
  deadlineAt: DateTimeSchema,
});
const LocalDataSyncPublicationBase = {
  requestId: Sha256Schema,
  artifactId: Sha256Schema,
  requestedAt: DateTimeSchema,
};
export const LocalDataSyncPublicationSchema = z.discriminatedUnion("status", [
  strictObject({ status: z.literal("not-required") }),
  strictObject({ status: z.literal("pending"), ...LocalDataSyncPublicationBase }),
  strictObject({
    status: z.literal("applied"),
    ...LocalDataSyncPublicationBase,
    appliedAt: DateTimeSchema,
  }),
  strictObject({
    status: z.literal("failed"),
    ...LocalDataSyncPublicationBase,
    failedAt: DateTimeSchema,
    code: z.enum(["WEB_PUBLICATION_FAILED", "WEB_PUBLICATION_CONTENT_MISMATCH"]),
  }),
]);
export type LocalDataSyncPublication = z.infer<typeof LocalDataSyncPublicationSchema>;
export const LocalDataSyncJobPublicSchema = strictObject({
  jobId: z.string().trim().min(1).max(200),
  jobVersion: z.number().int().positive().optional(),
  asins: z.array(AsinSchema),
  marketplace: MarketplaceSchema,
  status: z.string().min(1),
  message: z.string().min(1),
  currentStageId: z.string().min(1),
  stages: z.array(LocalDataSyncStageSchema),
  asinProgress: z.record(z.string(), z.record(z.string(), LocalDataSyncModuleResultSchema)),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
  dynamicSnapshot: z.enum(["pending", "ready"]).optional(),
  resumableStages: z.array(z.string().trim().min(1).max(100)).optional(),
  alexaVoc: LocalDataSyncAlexaVocSchema.optional(),
  publication: LocalDataSyncPublicationSchema.optional(),
  needsReload: z.boolean().optional(),
  completedAt: DateTimeSchema.nullable().optional(),
  queuePosition: z.number().int().min(0).max(100).nullable().optional(),
  scope: strictObject({
    projectId: EntityIdSchema.nullable(),
    runId: EntityIdSchema.nullable(),
  }).optional(),
});
export const LocalDataSyncJobSchema = LocalDataSyncJobPublicSchema;
export const LocalDataSyncResumeResponseSchema = strictObject({
  job: LocalDataSyncJobPublicSchema,
  resumedStages: z.array(z.string().trim().min(1).max(100)).min(1),
  reused: z.boolean(),
});
export const SyncLegacyRepairApplyRequestSchema = strictObject({
  version: z.string().regex(/^[A-Za-z0-9_-]{1,300}$/),
});
export const SyncLegacyRepairCandidateSchema = strictObject({
  asin: AsinSchema,
  module: z.string().trim().min(1).max(100),
  connectorId: ConnectorIdSchema,
  nextStatus: z.literal("pending"),
  reason: z.literal("LEGACY_UNVERIFIED"),
});
export const SyncLegacyRepairResponseSchema = strictObject({
  jobId: z.string().trim().min(1).max(200),
  version: z.string().regex(/^[A-Za-z0-9_-]{1,300}$/),
  candidates: z.array(SyncLegacyRepairCandidateSchema).max(100),
});
export type SyncLegacyRepairResponse = z.infer<typeof SyncLegacyRepairResponseSchema>;

const TrafficSnapshotReadCompetitorSchema = strictObject({
  asin: AsinSchema,
  brand: z.string().trim().min(1).max(200),
  trafficRank: z.number().int().positive(),
  trafficVolume: z.number().finite().nonnegative(),
  naturalVolume: z.number().finite().nonnegative(),
  naturalShare: z.number().finite().min(0).max(100),
  advertisingVolume: z.number().finite().nonnegative(),
  advertisingShare: z.number().finite().min(0).max(100),
  top1Share: z.number().finite().min(0).max(100),
  top3Share: z.number().finite().min(0).max(100),
  hhi: z.number().finite().min(0).max(10_000),
  effectiveChildren: z.number().int().nonnegative(),
  childCount: z.number().int().nonnegative(),
  recommendationTraffic: z.number().finite().nonnegative(),
  maxAdvertisingChannel: z.string().trim().min(1).max(200),
  maxAdvertisingChannelShare: z.number().finite().min(0).max(100),
  effectiveAdvertisingChannels: z.number().int().nonnegative(),
  pullGrade: z.enum(["强", "中强", "中", "中弱", "弱"]),
  naturalGrade: z.enum(["强", "中强", "中", "中弱", "弱"]),
  advertisingGrade: z.enum(["强", "中强", "中", "中弱", "弱"]),
  recommendationGrade: z.enum(["强", "中强", "中", "中弱", "弱"]),
  variantGrade: z.enum(["强", "中强", "中", "中弱", "弱"]),
  health: z.enum(["健康", "基本健康", "需观察", "风险较高"]),
  monthlyTrend: z.array(strictObject({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    natural: z.number().finite().nonnegative(),
    advertising: z.number().finite().nonnegative(),
    total: z.number().finite().nonnegative(),
  })).max(24),
});

export const TrafficSnapshotReadParamsSchema = strictObject({ runId: EntityIdSchema });
export const TrafficSnapshotReadResponseSchema = strictObject({
  version: z.literal("1"),
  state: z.literal("ready"),
  marketplace: MarketplaceSchema,
  asins: z.array(AsinSchema).min(1).max(10),
  source: z.literal("sif"),
  collectedAt: DateTimeSchema,
  traffic: strictObject({ competitors: z.array(TrafficSnapshotReadCompetitorSchema).max(10) }),
});
export type TrafficSnapshotReadResponse = z.infer<typeof TrafficSnapshotReadResponseSchema>;

export type ContractDefinition = Readonly<{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  params?: z.ZodType;
  query?: z.ZodType;
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
    method: "GET",
    path: "/v1/connectors",
    response: ConnectorCredentialListSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "PUT",
    path: "/v1/connectors/:connectorId/credential",
    request: ConnectorCredentialRequestSchema,
    response: ConnectorCredentialStateSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "DELETE",
    path: "/v1/connectors/:connectorId/credential",
    response: ConnectorCredentialStateSchema,
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
    method: "GET",
    path: "/v1/auth/dingtalk/config",
    response: DingTalkPublicConfigResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/auth/dingtalk/workbench",
    request: DingTalkWorkbenchLoginRequestSchema,
    response: DingTalkWorkbenchLoginResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/auth/dingtalk/oauth/start",
    request: DingTalkOAuthStartRequestSchema,
    response: DingTalkOAuthStartResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/auth/dingtalk/oauth/callback",
    request: DingTalkOAuthCallbackRequestSchema,
    response: DingTalkOAuthCallbackResponseSchema,
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
    method: "GET",
    path: "/v1/auth/session",
    response: SessionResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/auth/activity",
    request: ActivityRequestSchema,
    response: ActivityResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/auth/password",
    request: ChangePasswordRequestSchema,
    response: ChangePasswordResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/feedback",
    request: CreateFeedbackRequestSchema,
    response: CreateFeedbackResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/feedback/mine",
    response: FeedbackListResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/feedback/mine/:feedbackId",
    params: FeedbackIdParamsSchema,
    response: FeedbackDetailResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/feedback/mine/:feedbackId/attachments/:attachmentId",
    params: FeedbackAttachmentParamsSchema,
    response: z.instanceof(Uint8Array),
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/feedback/admin",
    query: FeedbackAdminListQuerySchema,
    response: FeedbackListResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/feedback/admin/unread-count",
    response: FeedbackUnreadCountResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/feedback/admin/:feedbackId",
    params: FeedbackIdParamsSchema,
    response: FeedbackDetailResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/feedback/admin/:feedbackId/attachments/:attachmentId",
    params: FeedbackAttachmentParamsSchema,
    response: z.instanceof(Uint8Array),
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/feedback/admin/:feedbackId/mark-seen",
    params: FeedbackIdParamsSchema,
    request: MarkFeedbackSeenRequestSchema,
    response: MarkFeedbackSeenResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/feedback/admin/:feedbackId/status",
    params: FeedbackIdParamsSchema,
    request: ChangeFeedbackStatusRequestSchema,
    response: FeedbackDetailResponseSchema,
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
    method: "POST",
    path: "/v1/manual-alexa-voc/import",
    request: ManualAlexaVocImportRequestSchema,
    response: ManualAlexaVocWriteResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/projects",
    response: ListProjectsResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/manual-alexa-voc",
    query: ManualAlexaVocListQuerySchema,
    response: ManualAlexaVocListResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/manual-alexa-voc/normalization-status",
    query: AlexaVocNormalizationStatusQuerySchema,
    response: AlexaVocNormalizationStatusResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "PATCH",
    path: "/v1/projects/:projectId",
    params: ProjectIdParamsSchema,
    request: UpdateProjectRequestSchema,
    response: UpdateProjectResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/legacy-projects/:legacyProjectId/eligibility",
    params: LegacyProjectIdParamsSchema,
    response: LegacyProjectEligibilityResponseSchema,
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
  {
    method: "GET",
    path: "/v1/projects/:projectId/runs/:runId/sync-jobs/:jobId/stages/:stage/output",
    params: LocalDataStageOutputParamsSchema,
    response: LocalDataStageOutputResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/admin/sync-asins/:jobId/resume",
    params: LocalDataSyncJobIdParamsSchema,
    response: LocalDataSyncResumeResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/admin/sync-asins/:jobId/legacy-repair/preview",
    params: LocalDataSyncJobIdParamsSchema,
    response: SyncLegacyRepairResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/admin/sync-asins/:jobId/legacy-repair/apply",
    params: LocalDataSyncJobIdParamsSchema,
    request: SyncLegacyRepairApplyRequestSchema,
    response: SyncLegacyRepairResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/admin/concurrency",
    response: ConcurrencyAdminResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/admin/users",
    response: AdminUserPresenceResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "PUT",
    path: "/v1/admin/concurrency/policy",
    request: ConcurrencyPolicyUpdateRequestSchema,
    response: ConcurrencyAdminResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "PUT",
    path: "/v1/admin/seller-sprite/quota/total",
    request: SellerSpriteQuotaTotalRequestSchema,
    response: ConcurrencyAdminResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/admin/seller-sprite/quota/refresh",
    request: z.object({}).strict(),
    response: ConcurrencyAdminResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/admin/concurrency/pause",
    request: ConcurrencyPauseRequestSchema,
    response: ConcurrencyAdminResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "POST",
    path: "/v1/admin/connectors/:connectorId/circuit/reset",
    params: ConnectorCircuitResetParamsSchema,
    request: z.object({}).strict(),
    response: ConcurrencyAdminResponseSchema,
    error: ApiErrorResponseSchema,
  },
  {
    method: "GET",
    path: "/v1/runs/:runId/traffic-snapshot",
    params: TrafficSnapshotReadParamsSchema,
    response: TrafficSnapshotReadResponseSchema,
    error: ApiErrorResponseSchema,
  },
] as const satisfies readonly ContractDefinition[];

export type AgentServiceV1Path =
  | "/v1/capabilities"
  | "/v1/connectors"
  | `/v1/connectors/${string}/credential`
  | "/v1/auth/login"
  | "/v1/auth/dingtalk/config"
  | "/v1/auth/dingtalk/workbench"
  | "/v1/auth/dingtalk/oauth/start"
  | "/v1/auth/dingtalk/oauth/callback"
  | "/v1/auth/logout"
  | "/v1/auth/session"
  | "/v1/auth/activity"
  | "/v1/auth/password"
  | "/v1/feedback"
  | "/v1/feedback/mine"
  | `/v1/feedback/mine/${string}`
  | `/v1/feedback/mine/${string}/attachments/${string}`
  | "/v1/feedback/admin"
  | "/v1/feedback/admin/unread-count"
  | `/v1/feedback/admin/${string}`
  | `/v1/feedback/admin/${string}/attachments/${string}`
  | `/v1/feedback/admin/${string}/mark-seen`
  | `/v1/feedback/admin/${string}/status`
  | "/v1/admin/concurrency"
  | "/v1/admin/users"
  | "/v1/admin/concurrency/policy"
  | "/v1/admin/seller-sprite/quota/total"
  | "/v1/admin/seller-sprite/quota/refresh"
  | "/v1/admin/concurrency/pause"
  | `/v1/admin/sync-asins/${string}/resume`
  | `/v1/admin/sync-asins/${string}/legacy-repair/preview`
  | `/v1/admin/sync-asins/${string}/legacy-repair/apply`
  | `/v1/admin/connectors/${string}/circuit/reset`
  | "/v1/projects"
  | `/v1/projects/${string}`
  | `/v1/projects/${string}/runs`
  | `/v1/runs/${string}`
  | `/v1/runs/${string}/cancel`
  | `/v1/runs/${string}/stages/${StageName}/retry`
  | `/v1/runs/${string}/reports`
  | `/v1/runs/${string}/traffic-snapshot`
  | `/v1/runs/${string}/voc-import`
  | "/v1/manual-alexa-voc/import"
  | "/v1/manual-alexa-voc"
  | `/v1/reports/${string}`
  | "/v1/local-voc"
  | "/v1/local-data/projects"
  | `/v1/local-data/projects/${string}`
  | "/v1/local-data/sync-asins"
  | `/v1/local-data/sync-asins/${string}`
  | `/v1/projects/${string}/runs/${string}/sync-jobs/${string}/stages/${ProjectableSyncStage}/output`;

const uuidV4PathPattern =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const retryStagePathPattern =
  "(?:traffic-analysis|voc-positioning|product-definition)";
const projectableSyncStagePathPattern =
  "(?:keywords|reviews|sales_trend|fba|listing|category|traffic|child_sales|price_strategy|image_remarks)";

const compiledContracts = v1Contracts.map((contract) => {
  const escapedPath = contract.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stagePathPattern = contract.path === "/v1/runs/:runId/stages/:stage/retry"
    ? retryStagePathPattern
    : projectableSyncStagePathPattern;
  const pattern = escapedPath
    .replace(
      /:(?:projectId|runId|reportId|feedbackId|attachmentId)/g,
      uuidV4PathPattern,
    )
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
