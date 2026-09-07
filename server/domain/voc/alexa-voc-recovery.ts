import {
  AgentRunTerminalMetadataSchema,
  Sha256Schema,
} from "../../../shared/agent-contracts";
import type { JobAttemptRecord } from "../../db/repository";
import { ALEXA_VOC_NORMALIZATION_SKILL } from "./alexa-voc-normalization-contracts";

type Row = Record<string, unknown>;
export type NormalizationTerminalRepair = Readonly<{
  snapshotId: string;
  asin: string;
  fingerprint: string;
  agentRunId: string | null;
}>;
export type NormalizationRecoveryJob = Pick<
  JobAttemptRecord,
  | "id"
  | "stageId"
  | "runId"
  | "logicalExecutionCycleId"
  | "attemptNumber"
  | "retryCycleStartAttempt"
  | "maxAttempts"
  | "status"
  | "error"
  | "reportPublicationMaxAttempts"
>;

// These queries deliberately load every audit before reduction, including audits
// without a valid snapshot link. An inner join would hide corrupted identities.
export function normalizationRecoveryQueries(job: NormalizationRecoveryJob) {
  return [
    {
      sql: `SELECT ar.*, p.organization_id AS trusted_organization_id, j.stage_id AS job_stage_id,
              j.logical_execution_cycle_id AS job_cycle_id,
              (SELECT COUNT(*) FROM agent_run_snapshots link WHERE link.agent_run_id = ar.id) AS linked_snapshot_count,
              (SELECT MIN(link.snapshot_id) FROM agent_run_snapshots link WHERE link.agent_run_id = ar.id) AS linked_snapshot_id
           FROM agent_runs ar LEFT JOIN job_attempts j ON j.id = ar.job_attempt_id
           LEFT JOIN analysis_runs r ON r.id = ar.run_id
           LEFT JOIN projects p ON p.id = r.project_id
          WHERE ar.stage_id = ? AND ar.logical_execution_cycle_id = ?`,
      values: [job.stageId, job.logicalExecutionCycleId],
    },
    {
      sql: `SELECT ds.*, p.organization_id, p.id AS project_id
           FROM data_snapshots ds JOIN analysis_runs r ON r.id = ds.run_id
           JOIN projects p ON p.id = r.project_id
          WHERE ds.run_id = ? AND ds.artifact_kind = 'alexa-voc-normalization-input'`,
      values: [job.runId],
    },
    {
      sql: `SELECT terminal.*, j.id AS terminal_job_id, j.stage_id AS terminal_job_stage_id,
              j.attempt_number AS terminal_job_attempt_number,
              j.retry_cycle_start_attempt AS terminal_retry_cycle_start_attempt,
              stage.run_id AS terminal_job_run_id, stage.stage AS terminal_job_stage,
              ar.id AS source_audit_id, ar.run_id AS source_audit_run_id,
              ar.stage_id AS source_audit_stage_id, ar.job_attempt_id AS source_audit_job_id,
              ar.execution_fingerprint AS source_audit_fingerprint,
              ar.validation_status AS source_validation_status, ar.terminal_status AS source_terminal_status,
              ar.snapshot_ids_json AS source_audit_snapshot_ids_json,
              source_job.stage_id AS source_job_stage_id,
              source_stage.run_id AS source_job_run_id, source_stage.stage AS source_job_stage,
              source.id AS source_snapshot_id, source.run_id AS source_snapshot_run_id,
              source.marketplace AS source_marketplace, source.asins_json AS source_asins_json,
              source.snapshot_kind AS source_snapshot_kind, source.artifact_kind AS source_artifact_kind,
              source.content_hash AS source_content_hash, source.payload_json AS source_payload_json,
              source_project.organization_id AS source_organization_id,
              skill.skill_id AS source_skill_id,
              (SELECT COUNT(*) FROM agent_run_snapshots links WHERE links.agent_run_id = ar.id) AS source_link_count
           FROM alexa_voc_normalization_terminals terminal
           LEFT JOIN job_attempts j ON j.id = terminal.job_attempt_id
           LEFT JOIN run_stages stage ON stage.id = j.stage_id
           LEFT JOIN agent_runs ar ON ar.id = terminal.agent_run_id
           LEFT JOIN job_attempts source_job ON source_job.id = ar.job_attempt_id
           LEFT JOIN run_stages source_stage ON source_stage.id = source_job.stage_id
           LEFT JOIN agent_run_snapshots link ON link.agent_run_id = ar.id
           LEFT JOIN data_snapshots source ON source.id = link.snapshot_id
           LEFT JOIN analysis_runs source_run ON source_run.id = source.run_id
           LEFT JOIN projects source_project ON source_project.id = source_run.project_id
           LEFT JOIN skill_versions skill ON skill.id = ar.skill_version_id
          WHERE terminal.run_id = ?`,
      values: [job.runId],
    },
  ];
}

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

export function normalizationRecoveryDisposition(
  job: NormalizationRecoveryJob,
  records: readonly Row[][],
) {
  const [audits, snapshots, terminals] = records;
  const invalid = () => {
    throw new Error("Invalid normalization recovery identity");
  };
  if (!audits || !snapshots || !terminals) return invalid();
  const inputs = new Map<
    string,
    { fingerprint: string; organizationId: unknown; asin: unknown }
  >();
  for (const snapshot of snapshots) {
    const payload = json(snapshot.payload_json) as Row;
    if (
      !payload ||
      snapshot.run_id !== job.runId ||
      snapshot.snapshot_kind !== "alexa-voc-normalization-input" ||
      snapshot.marketplace !== "US"
    )
      return invalid();
    const fingerprint = Sha256Schema.parse(payload.executionFingerprint);
    if (
      snapshot.content_hash !== fingerprint ||
      inputs.has(String(snapshot.id))
    )
      return invalid();
    inputs.set(String(snapshot.id), {
      fingerprint,
      organizationId: snapshot.organization_id,
      asin: payload.asin,
    });
  }
  const byInput = new Map<
    string,
    { kind: "passed" | "pending" | "transient" | "terminal" }
  >();
  const terminalMetadata: ReturnType<
    typeof AgentRunTerminalMetadataSchema.parse
  >[] = [];
  const fingerprints = new Set<string>();
  for (const audit of audits) {
    const ids = json(audit.snapshot_ids_json);
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string")
      return invalid();
    const input = inputs.get(ids[0]);
    const fingerprint = Sha256Schema.parse(audit.execution_fingerprint);
    if (
      Number(audit.linked_snapshot_count) !== 1 ||
      audit.linked_snapshot_id !== ids[0]
    )
      return invalid();
    if (
      !input ||
      input.fingerprint !== fingerprint ||
      input.organizationId !== audit.trusted_organization_id ||
      audit.run_id !== job.runId ||
      audit.stage_id !== job.stageId ||
      audit.job_stage_id !== job.stageId ||
      audit.job_cycle_id !== job.logicalExecutionCycleId ||
      fingerprints.has(fingerprint) ||
      byInput.has(ids[0])
    )
      return invalid();
    fingerprints.add(fingerprint);
    if (audit.validation_status === "pending") {
      if (
        audit.terminal_status !== null ||
        audit.terminal_metadata_json !== null
      )
        return invalid();
      byInput.set(ids[0], { kind: "pending" });
      continue;
    }
    const metadata = AgentRunTerminalMetadataSchema.parse(
      json(audit.terminal_metadata_json),
    );
    terminalMetadata.push(metadata);
    if (audit.validation_status === "passed") {
      if (
        metadata.kind !== "succeeded" ||
        audit.terminal_status !== "succeeded"
      )
        return invalid();
      byInput.set(ids[0], { kind: "passed" });
    } else {
      if (
        audit.validation_status !== "failed" ||
        metadata.kind === "succeeded" ||
        audit.terminal_status !==
          (metadata.kind === "cancelled" || metadata.kind === "budget-exceeded"
            ? metadata.kind
            : "failed")
      )
        return invalid();
      byInput.set(ids[0], {
        kind:
          metadata.kind === "failed" &&
          (metadata.classification === "upstream-temporary" ||
            metadata.classification === "rate-limit")
            ? "transient"
            : "terminal",
      });
    }
  }
  const completed = new Set<string>();
  for (const terminal of terminals) {
    const input = inputs.get(String(terminal.snapshot_id));
    if (
      !input ||
      terminal.run_id !== job.runId ||
      terminal.asin !== input.asin ||
      terminal.execution_fingerprint !== input.fingerprint ||
      terminal.job_attempt_id !== terminal.terminal_job_id ||
      terminal.terminal_job_stage_id !== job.stageId ||
      terminal.terminal_job_run_id !== job.runId ||
      terminal.terminal_job_stage !== "alexa-voc-normalization" ||
      !["success", "failure"].includes(String(terminal.status))
    )
      return invalid();
    if (terminal.agent_run_id !== null) {
      const sourceIds = json(terminal.source_audit_snapshot_ids_json);
      const sourceAsins = json(terminal.source_asins_json);
      const sourcePayload = json(terminal.source_payload_json) as Row | null;
      if (
        terminal.agent_run_id !== terminal.source_audit_id ||
        terminal.source_audit_fingerprint !== input.fingerprint ||
        terminal.source_organization_id !== input.organizationId ||
        terminal.source_marketplace !== "US" ||
        !Array.isArray(sourceAsins) ||
        sourceAsins.length !== 1 ||
        sourceAsins[0] !== input.asin ||
        !Array.isArray(sourceIds) ||
        sourceIds.length !== 1 ||
        sourceIds[0] !== terminal.source_snapshot_id ||
        Number(terminal.source_link_count) !== 1 ||
        terminal.source_snapshot_kind !== "alexa-voc-normalization-input" ||
        terminal.source_artifact_kind !== "alexa-voc-normalization-input" ||
        terminal.source_content_hash !== input.fingerprint ||
        sourcePayload?.executionFingerprint !== input.fingerprint ||
        sourcePayload?.asin !== input.asin ||
        terminal.source_audit_run_id !== terminal.source_snapshot_run_id ||
        terminal.source_audit_run_id !== terminal.source_job_run_id ||
        terminal.source_audit_stage_id !== terminal.source_job_stage_id ||
        terminal.source_job_stage !== "alexa-voc-normalization" ||
        terminal.source_skill_id !== ALEXA_VOC_NORMALIZATION_SKILL.id
      )
        return invalid();
      // Historical success can originate in another run/project/cycle. Validate
      // immutable provenance, not the currently deployed skill version/hash.
      if (terminal.status === "success") {
        if (
          terminal.source_validation_status !== "passed" ||
          terminal.source_terminal_status !== "succeeded"
        )
          return invalid();
      } else if (
        terminal.source_validation_status !== "failed" ||
        terminal.source_audit_run_id !== job.runId ||
        terminal.source_audit_stage_id !== job.stageId ||
        terminal.source_audit_job_id !== terminal.job_attempt_id ||
        terminal.source_snapshot_id !== terminal.snapshot_id
      )
        return invalid();
    } else if (terminal.status === "success") return invalid();
    if (
      terminal.status === "success" ||
      (Number(terminal.terminal_retry_cycle_start_attempt) ===
        job.retryCycleStartAttempt &&
        Number(terminal.terminal_job_attempt_number) >=
          job.retryCycleStartAttempt &&
        Number(terminal.terminal_job_attempt_number) <= job.attemptNumber)
    )
      completed.add(String(terminal.snapshot_id));
  }
  const remaining = [...inputs.keys()].filter((id) => !completed.has(id));
  // Once publication has its own bounded policy, new queued inputs cannot
  // convert this lease back into execution or allocate another successor.
  // The runtime leaves those inputs to the explicitly queued job.
  if (job.reportPublicationMaxAttempts !== null && audits.length > 0) {
    return {
      kind: "recover",
      mode: remaining.length ? "report-only" : "completion-only",
    } as const;
  }
  if (
    remaining.length === 0 &&
    inputs.size > 0 &&
    (audits.length > 0 ||
      terminals.every((terminal) => terminal.status === "success"))
  )
    return { kind: "recover", mode: "completion-only" } as const;
  const states = remaining.map((id) => byInput.get(id)?.kind ?? "absent");
  // Persist/reconcile every successful audited output in its original cycle
  // before a transient sibling may advance to a fresh execution cycle.
  if (states.includes("passed")) {
    if (
      job.attemptNumber < job.maxAttempts &&
      states.some((state) => state !== "passed")
    )
      return { kind: "recover", mode: "pending" } as const;
    return { kind: "recover", mode: "report-only" } as const;
  }
  const cancelled = terminalMetadata.some(
    (metadata) => metadata.kind === "cancelled",
  );
  const budget = terminalMetadata.find(
    (metadata) => metadata.kind === "budget-exceeded",
  );
  if (cancelled || budget?.kind === "budget-exceeded") {
    const normalizationTerminals: NormalizationTerminalRepair[] = remaining.map(
      (id) => {
        const input = inputs.get(id)!;
        const audit = audits.find(
          (candidate) =>
            (json(candidate.snapshot_ids_json) as string[])[0] === id &&
            candidate.validation_status === "failed",
        );
        return {
          snapshotId: id,
          asin: String(input.asin),
          fingerprint: input.fingerprint,
          agentRunId: audit ? String(audit.id) : null,
        };
      },
    );
    return {
      kind: "settle",
      attemptStatus: cancelled ? "cancelled" : "failed",
      stageStatus: cancelled ? "cancelled" : "budget-exceeded",
      normalizationTerminals,
      error: cancelled
        ? {
            classification: "cancelled",
            code: "CANCELLED",
            message: "Skill execution was cancelled",
          }
        : {
            classification: "configuration",
            code: "CONFIGURATION_ERROR",
            message: "Configured model budget was exceeded",
            scope: budget!.scope,
            metric: budget!.metric,
            used: budget!.used,
            projected: budget!.projected,
            limit: budget!.limit,
          },
    } as const;
  }
  if (job.attemptNumber < job.maxAttempts) {
    if (states.includes("transient"))
      return {
        kind: "retry-new-cycle",
        error: {
          classification: "upstream-temporary",
          code: "UPSTREAM_ERROR",
          message: "Normalization input requires execution retry",
        },
      } as const;
    if (states.includes("pending") || states.includes("absent"))
      return {
        kind: "recover",
        mode: audits.length ? "pending" : "unstarted",
      } as const;
  }
  // At the limit the normalization runtime reconciles each input separately.
  // This grants a publication lease, never model-call authority to a sibling.
  if (audits.length > 0)
    return { kind: "recover", mode: "report-only" } as const;
  return job.status === "running"
    ? ({ kind: "recover", mode: "unstarted" } as const)
    : ({
        kind: "retry-new-cycle",
        error: job.error ?? {
          classification: "infrastructure",
          message: "Normalization execution did not start",
        },
      } as const);
}

export function normalizationSettlementQueries(
  job: NormalizationRecoveryJob,
  repairs: readonly NormalizationTerminalRepair[] | undefined,
  completedAt: string,
) {
  return (repairs ?? []).map((repair) => ({
    sql: `INSERT INTO alexa_voc_normalization_terminals
      (snapshot_id, run_id, job_attempt_id, agent_run_id, asin, execution_fingerprint, status, error_category, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'failure', 'persistence', ?)
      ON CONFLICT (snapshot_id, job_attempt_id) DO NOTHING`,
    values: [
      repair.snapshotId,
      job.runId,
      job.id,
      repair.agentRunId,
      repair.asin,
      repair.fingerprint,
      completedAt,
    ],
  }));
}
