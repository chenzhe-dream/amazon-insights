import {loadMarketOverviewSynthesisEvidence} from '../services/market-overview-synthesis-input-service';
import {loadMarketShapeSynthesisEvidence} from '../services/market-shape-synthesis-input-service';
import {loadMarketShapeExplanationCatalog} from '../services/market-shape-explanation-input-service';
import {marketSemanticWire} from './market-semantic-wire';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { inspectMarketContinuation, isMarketAutomaticFlow } from '../domain/market-research/module-flow';
import { MarketExecutionSubjectSchema, type MarketModelExecutionAuthority } from '../../shared/market-execution-subject';
import { MarketSemanticTaskNameSchema, type MarketSemanticInput, type MarketSemanticOutput, type MarketSemanticRecord, type MarketSemanticValidationBinding } from '../../shared/market-semantic-contracts';
import type { FinalizeAgentRunOutcome } from '../db/agent-run-repository';
import { MarketAgentRunConflictError, type MarketAgentRunRecord } from '../db/market-agent-run-repository';
import type { MarketStepClaim, MarketStepError, MarketStepOutcome } from '../db/market-module-execution-repository';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketModelBudgetStore } from '../db/postgres/market-model-budget-store';
import * as validation from '../domain/market-research/semantic-validation';
import { marketSemanticContracts, marketSemanticOutputContract, marketSemanticExecutionDefinition } from '../skills/market-semantic-task-definitions';
import type { SkillRegistry } from '../skills/registry';
import { mergeAttemptMetadata, normalizeExecutionError } from './agent-run-service';
import { createTrustedExecutionAbortReason, trustedExecutionAbortKind } from './execution-abort';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import { MARKET_REQUEST_ESTIMATION_VERSION } from './market-request-admission';
import { createMarketSemanticSkillRunner, type MarketSemanticRunnerConfiguration } from './market-semantic-runner';
import { getSkillRunFailureAudit, SkillRuntimeError } from './skill-runner';

export interface ResolvedMarketSemanticConfiguration extends MarketSemanticRunnerConfiguration { configurationVersion: string }
export type MarketSemanticExecutionResult = {
  status: 'succeeded' | 'failed' | 'observing'; agentRun: MarketAgentRunRecord; value: MarketSemanticOutput | null; replayed: boolean;
};
interface ExecutionOptions { leaseMs?: number; heartbeatMs?: number; batchTimeoutMs?: number; stageTimeoutMs?: number }
const DEADLINE_MESSAGE = 'Market semantic batch or stage deadline exceeded';
const REQUEST_TIMEOUT_MESSAGE = 'Market semantic model request timed out';
class MarketDeadlineError extends SkillRuntimeError { constructor() { super('TIMEOUT', DEADLINE_MESSAGE); } }
const batchSchema = z.object({ task: MarketSemanticTaskNameSchema, bindingId: z.string().uuid(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const outputValidators = {
  'market-overview-synthesis':validation.validateMarketOverviewSynthesisOutput,
  'market-shape-synthesis':validation.validateMarketShapeSynthesisOutput,
  'market-shape-structure-explanation':validation.validateMarketShapeStructureExplanation,
  'market-overview-explanation': validation.validateMarketOverviewExplanation,
  'market-product-shape-suggestion': validation.validateMarketShapeSuggestions,
  'market-keyword-semantics': validation.validateMarketKeywordSemantics,
  'market-customer-theme-mapping': validation.validateMarketCustomerThemeMapping,
};
function same(left: unknown, right: unknown) { if (digest(left) !== digest(right)) throw new MarketAgentRunConflictError(); }
function stepOutcome(record: MarketAgentRunRecord): MarketStepOutcome {
  if (!record.outcome) throw new MarketAgentRunConflictError();
  const reference = { agentRunId: record.id, bindingId: record.bindingId, task: record.task, executionFingerprint: record.executionFingerprint };
  if (record.outcome.terminalStatus === 'succeeded') return { status: 'succeeded', output: reference };
  const code: MarketStepError['code'] = record.outcome.error?.code === 'CANCELLED' ? 'cancelled'
    : record.outcome.terminalStatus === 'budget-exceeded' ? 'governance'
    : [DEADLINE_MESSAGE, REQUEST_TIMEOUT_MESSAGE].includes(record.outcome.error?.message ?? '') ? 'timeout'
    : record.outcome.error?.code === 'UPSTREAM_TEMPORARY' ? 'upstream-temporary'
    : record.outcome.error?.code === 'AUTHENTICATION_REQUIRED' ? 'authentication'
    : ['MODEL_OUTPUT_ERROR', 'VALIDATION_ERROR'].includes(record.outcome.error?.code ?? '') ? 'invalid-data' : 'internal';
  return { status: 'failed', error: { code, retryable: false }, diagnostic: reference };
}

/** Runs only a previously claimed, persisted model-batch. The planner owns batch creation.
 * All stores share one query context so audit and step completion commit together.
 */
export class MarketSemanticExecutionService {
  readonly #audit: PostgresMarketAgentRunStore;
  readonly #steps: PostgresMarketModuleExecutionStore;
  readonly #snapshots: PostgresMarketAnalysisSnapshotStore;
  readonly #budget: PostgresMarketModelBudgetStore;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  constructor(private readonly context: PostgresQueryContext, private readonly registry: SkillRegistry, private readonly options: ExecutionOptions = {}) {
    this.options = Object.freeze({ ...options });
    this.#audit = new PostgresMarketAgentRunStore(context); this.#steps = new PostgresMarketModuleExecutionStore(context);
    this.#snapshots = new PostgresMarketAnalysisSnapshotStore(context); this.#budget = new PostgresMarketModelBudgetStore(context);
    this.#leaseMs = z.number().int().min(300).max(120000).parse(options.leaseMs ?? 30000);
    this.#heartbeatMs = z.number().int().min(25).max(this.#leaseMs / 3).parse(options.heartbeatMs ?? 5000);
  }

  async executeBatch(claim: MarketStepClaim, configuration: ResolvedMarketSemanticConfiguration, signal?: AbortSignal): Promise<MarketSemanticExecutionResult> {
    const batch = batchSchema.parse(claim.step.input);
    if (claim.step.kind !== 'model-batch' || batch.task !== configuration.task) throw new MarketAgentRunConflictError();
    const actor = { organizationId: claim.organizationId, userId: claim.createdBy };
    const readScope = { actor, studyId: claim.studyId, moduleRunId: claim.moduleRunId };
    const view = await this.#steps.findModuleRun({ actor, moduleRunId: claim.moduleRunId });
    const step = view?.steps.find(s => s.id === claim.stepId);
    if (!view || !step || step.latestAttemptId !== claim.attemptId || view.run.createdBy !== claim.createdBy ||
      view.run.scope.researchId !== claim.studyId || view.run.versions.configuration !== configuration.configurationVersion ||
      view.run.versions.model !== 'market.semantic.text.v1' || view.run.status === 'cancelled') throw new MarketAgentRunConflictError();
    same(claim.step, { stepKey: step.stepKey, kind: step.kind, subject: step.subject, input: step.input, inputRefs: step.inputRefs });
    if (digest(claim.step) !== claim.inputHash || step.inputHash !== claim.inputHash) throw new MarketAgentRunConflictError();
    if (isMarketAutomaticFlow(view.run) && !inspectMarketContinuation(view, new Date().toISOString()).currentStepKeys.includes(step.stepKey)) throw new MarketAgentRunConflictError();
    const saved = await this.#audit.findSnapshotBinding({ ...readScope, bindingId: batch.bindingId });
    if (!saved || saved.task !== batch.task || saved.inputDigest !== batch.inputDigest) throw new MarketAgentRunConflictError();
    const sourceInput = await this.#snapshots.findInput({ actor, studyId: claim.studyId, id: saved.inputSnapshotId });
    if (!sourceInput) throw new MarketAgentRunConflictError();
    const sources = await Promise.all(saved.sourceRefs.map(id => this.#snapshots.findSource({ actor, studyId: claim.studyId, id })));
    if (sources.some(s => !s)) throw new MarketAgentRunConflictError();
    const shapeExplanationCatalog=batch.task==='market-shape-structure-explanation'?await loadMarketShapeExplanationCatalog(this.context,actor,claim.moduleRunId):undefined;
    const synthesisEvidence=batch.task==='market-overview-synthesis'?await loadMarketOverviewSynthesisEvidence(this.context,actor,claim.moduleRunId,saved.inputSnapshotId):batch.task==='market-shape-synthesis'?await loadMarketShapeSynthesisEvidence(this.context,actor,claim.moduleRunId,saved.inputSnapshotId):{};
    const binding: MarketSemanticValidationBinding = { ...(shapeExplanationCatalog?{shapeExplanationCatalog}:{}),...synthesisEvidence, scope: sourceInput.snapshot.scope, inputSnapshot: sourceInput.snapshot,
      sourceEvidenceByRef: Object.fromEntries(sources.map(s => [s!.id, s!.evidence])), selectionRevision: saved.selectionRevision,
      batchKey: saved.batchKey, inputDigest: saved.inputDigest, expectedIds: saved.memberRefs,
      sourceCatalog: Object.fromEntries(sourceInput.snapshot.records.map(r => [r.id, (r.data as { semantic: MarketSemanticRecord }).semantic])) };
    const input = validation.validateMarketSemanticInput(saved.inputProjection, binding);
    const subject = MarketExecutionSubjectSchema.parse({ kind: 'market-module-run', organizationId: claim.organizationId, studyId: claim.studyId,
      moduleRunId: claim.moduleRunId, stepId: claim.stepId, attemptId: claim.attemptId, leaseOwnerId: claim.leaseOwnerId,
      leaseGeneration: claim.leaseGeneration, dataCutoffAt: input.dataCutoffAt });
    const definition = marketSemanticExecutionDefinition(input);
    const batchMs = z.number().int().min(100).max(definition.batchTimeoutMs).parse(this.options.batchTimeoutMs ?? definition.batchTimeoutMs);
    const stageMs = z.number().int().min(100).max(definition.stageTimeoutMs).parse(this.options.stageTimeoutMs ?? definition.stageTimeoutMs);
    const queryStarted = performance.now();
    const timing = (await this.context.query<{ started_at: Date; stage_started_at: Date | null; now: Date }>(`SELECT a.started_at, clock_timestamp() AS now,
      (SELECT min(p.started_at) FROM market_analysis_step_attempts p JOIN market_analysis_steps s ON s.id=p.step_id
        WHERE p.run_id=a.run_id AND p.organization_id=a.organization_id AND s.kind='prepare-model-batches'
          AND ($7::text IS DISTINCT FROM 'market-overview-synthesis' OR s.definition_json->'input'->>'task'=$7)) AS stage_started_at
      FROM market_analysis_step_attempts a WHERE a.id=$1 AND a.step_id=$2 AND a.run_id=$3 AND a.organization_id=$4
        AND a.lease_owner_id=$5 AND a.lease_generation=$6`,
    [claim.attemptId, claim.stepId, claim.moduleRunId, claim.organizationId, claim.leaseOwnerId, claim.leaseGeneration, batch.task])).rows[0];
    if (!timing?.stage_started_at) throw new MarketAgentRunConflictError();
    const deadlineAt = new Date(Math.min(timing.started_at.getTime() + batchMs, timing.stage_started_at.getTime() + stageMs)).toISOString();
    const deadlineMono = queryStarted + Date.parse(deadlineAt) - timing.now.getTime();
    const controller = new AbortController();
    const externalAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', externalAbort, { once: true }); if (signal?.aborted) externalAbort();
    const ensure = () => {
      if (performance.now() >= deadlineMono) throw new MarketDeadlineError();
      if (controller.signal.aborted) throw new SkillRuntimeError(trustedExecutionAbortKind(controller.signal) === 'run-cancelled' ? 'CANCELLED' : 'INTERRUPTED', 'Market semantic execution interrupted');
    };
    let authority: MarketModelExecutionAuthority | undefined;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let inflight: Promise<void> | undefined;
    let stopped = false;
    const deadlineTimer = setTimeout(() => controller.abort(new MarketDeadlineError()), Math.max(0, deadlineMono - performance.now()));
    const heartbeat = async () => {
      try {
        ensure();
        if (!await this.#steps.renewStep({ claim, leaseMs: this.#leaseMs })) throw new MarketAgentRunConflictError();
        if (authority) {
          const renewed = await this.#audit.claimAgentRun({ authority, claimTtlMs: this.#leaseMs });
          if (renewed.claimStatus !== 'acquired') throw new MarketAgentRunConflictError();
        }
      } catch { controller.abort(createTrustedExecutionAbortReason('lease-lost')); }
      if (!stopped && !controller.signal.aborted) heartbeatTimer = setTimeout(() => { inflight = heartbeat(); }, this.#heartbeatMs);
    };
    const stop = async () => { stopped = true; if (heartbeatTimer) clearTimeout(heartbeatTimer); clearTimeout(deadlineTimer); await inflight; };
    try {
      const runner = createMarketSemanticSkillRunner(this.context, this.registry, configuration);
      const contracts = marketSemanticContracts[batch.task];
      const outputContract=marketSemanticOutputContract(input),wire=marketSemanticWire(input),inputSchema=wire.inputSchema??contracts.input;
      const prepared = await runner.prepare<unknown, MarketSemanticOutput>({ skill: definition.skill,
        inputContract: { name: definition.inputSchema, schema: inputSchema, allowedFields: Object.keys(inputSchema.shape) },
        outputContract: { name: definition.outputSchema, schema: outputContract.output, schemaDefinitions: wire.responseSchema?wire.responseSchemaDefinitions:outputContract.schemaDefinitions, responseSchema:wire.responseSchema,
          canonicalizeOutput: candidate => outputValidators[batch.task](input, wire.decode(candidate), binding) },
        input:wire.input, snapshotIds: [saved.id], model: configuration.model, signal: controller.signal });
      const fingerprint = digest({ subject, bindingId: saved.id, inputDigest: saved.inputDigest, skill: prepared.skill,
        inputSchemaDigest: prepared.inputContract.schemaDigest, outputSchemaDigest: prepared.outputContract.schemaDigest,...(wire.encoding==='canonical/v1'?{}:{referenceEncoding:wire.encoding}),
        provider: prepared.providerName, model: prepared.model, configurationVersion: configuration.configurationVersion,
        versions: view.run.versions, transport: configuration.transport, schemaPromptMode: 'native',
        estimationVersion: MARKET_REQUEST_ESTIMATION_VERSION, batchMs, stageMs, deadlineAt });
      const replay = (record: MarketAgentRunRecord): MarketSemanticExecutionResult => {
        if (record.executionFingerprint !== fingerprint || record.attemptId !== claim.attemptId || record.bindingId !== saved.id || !record.outcome) throw new MarketAgentRunConflictError();
        runner.assertPreparedContractIdentity(prepared);
        const value = record.outcome.terminalStatus === 'succeeded' ? outputValidators[batch.task](input, record.outcome.output, binding) : null;
        return { status: value ? 'succeeded' : 'failed', value, agentRun: record, replayed: true };
      };
      if (step.status !== 'running') {
        const record = (await this.#audit.listAgentRuns(readScope)).find(r => r.attemptId === claim.attemptId);
        if (!record) throw new MarketAgentRunConflictError();
        const expected = stepOutcome(record), attempt = view.attempts.find(a => a.id === claim.attemptId);
        if (!attempt || step.status !== expected.status || attempt.status !== expected.status) throw new MarketAgentRunConflictError();
        if (expected.status === 'succeeded') same(attempt.output, expected.output); else if (expected.status === 'failed') same(attempt.error, expected.error);
        return replay(record);
      }
      // Begin/recovery are permitted after the deadline solely to persist a fenced failure.
      if (!await this.#steps.renewStep({ claim, leaseMs: this.#leaseMs })) throw new MarketAgentRunConflictError();
      const version = await this.#audit.registerSkillVersion({ id: randomUUID(), skillId: prepared.skill.id, version: prepared.skill.version,
        contentHash: prepared.skill.contentHash, manifest: prepared.skill, createdAt: timing.now.toISOString() });
      const claimToken = randomUUID();
      const begun = await this.#audit.beginAgentRun({ id: randomUUID(), subject, task: batch.task, bindingId: saved.id, skillVersionId: version.id,
        skill: { id: prepared.skill.id, version: prepared.skill.version, contentHash: prepared.skill.contentHash },
        inputSchema: definition.inputSchema, outputSchema: definition.outputSchema, executionFingerprint: fingerprint,
        outputSchemaDigest: prepared.outputContract.schemaDigest, provider: prepared.providerName, model: prepared.model.name, claimToken, claimTtlMs: this.#leaseMs });
      if (begun.claimStatus === 'observing') return { status: 'observing', value: null, agentRun: begun.record, replayed: false };
      if (begun.claimStatus === 'terminal') throw new MarketAgentRunConflictError(); // Atomic commits cannot leave a terminal audit on a running step.
      authority = { ...subject, agentRunId: begun.record.id, claimToken };
      inflight = heartbeat(); await inflight;
      let execution: Awaited<ReturnType<typeof runner.runPrepared<unknown, MarketSemanticOutput>>> | undefined;
      let error: unknown;
      const before = await this.#budget.getAgentUsage(authority);
      try {
        ensure();
        if (before.reservationCount > 0) throw new Error('Prior physical execution was not durably committed');
        execution = await runner.runPrepared(prepared, subject, authority);
        ensure();
      } catch (caught) { error = performance.now() >= deadlineMono ? new MarketDeadlineError() : caught; }
      const usage = await this.#budget.getAgentUsage(authority);
      const local = getSkillRunFailureAudit(error);
      const attempts = mergeAttemptMetadata(usage.attempts, execution?.record.attempts ?? local?.attempts ?? []);
      const accounting = { responseId: usage.responseId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        estimatedCostMicros: usage.estimatedCostMicros, durationMs: Math.max(0, Math.round(performance.now() - queryStarted)),
        attemptCount: attempts.length, usageCompleteness: usage.usageCompleteness, attempts };
      const failed = (reason: unknown): FinalizeAgentRunOutcome => {
        const normalized = normalizeExecutionError(reason, reason instanceof MarketDeadlineError ? null : local, begun.record.id);
        const timeoutMessage = reason instanceof MarketDeadlineError ? DEADLINE_MESSAGE
          : reason instanceof SkillRuntimeError && reason.code === 'TIMEOUT' ? REQUEST_TIMEOUT_MESSAGE : undefined;
        return { ...accounting, terminalStatus: normalized.terminalStatus, validationStatus: 'failed', output: null,
          error: { ...normalized.error, ...(timeoutMessage ? { message: timeoutMessage } : {}), retryable: false }, terminalMetadata: normalized.terminalMetadata };
      };
      const outcome: FinalizeAgentRunOutcome = error || !execution ? failed(error) : { ...accounting, terminalStatus: 'succeeded', validationStatus: 'passed',
        output: execution.value as unknown as Record<string, unknown>, error: null, terminalMetadata: { kind: 'succeeded' } };
      await stop();
      const finish = (terminal: FinalizeAgentRunOutcome) => this.context.transaction(async () => {
        if (terminal.terminalStatus === 'succeeded') ensure();
        const finalized = await this.#audit.finalizeAgentRun({ authority: authority!, outcome: terminal });
        const receipt = await this.#steps.settleAndEnqueue({ claim, outcome: stepOutcome(finalized.record) });
        if (receipt.status === 'lease-lost') throw new MarketAgentRunConflictError();
        if (terminal.terminalStatus === 'succeeded') {
          ensure();
          const live = (await this.context.query<{ live: boolean }>('SELECT clock_timestamp()<$1::timestamptz AS live', [deadlineAt])).rows[0].live;
          if (!live) throw new MarketDeadlineError();
          ensure();
        }
        return finalized.record;
      });
      let record: MarketAgentRunRecord;
      try { record = await finish(outcome); }
      catch (caught) { if (caught instanceof MarketDeadlineError && outcome.terminalStatus === 'succeeded') record = await finish(failed(caught)); else throw caught; }
      return { status: record.terminalStatus === 'succeeded' ? 'succeeded' : 'failed', value: record.terminalStatus === 'succeeded' ? execution!.value : null, agentRun: record, replayed: false };
    } finally { await stop(); signal?.removeEventListener('abort', externalAbort); }
  }
}
