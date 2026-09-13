import {loadMarketOverviewSynthesisEvidence} from '../services/market-overview-synthesis-input-service';
import {loadMarketShapeSynthesisEvidence} from '../services/market-shape-synthesis-input-service';
import {loadMarketShapeExplanationCatalog} from '../services/market-shape-explanation-input-service';
import { z } from 'zod';
import { MarketSemanticRecordSchema, MarketSemanticTaskNameSchema } from '../../shared/market-semantic-contracts';
import { MarketExecutionSubjectSchema } from '../../shared/market-execution-subject';
import type { MarketSourceEvidence } from '../../shared/market-source-contracts';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { MarketAgentRunConflictError } from '../db/market-agent-run-repository';
import type { MarketStepClaim } from '../db/market-module-execution-repository';
import type { SkillRegistry } from '../skills/registry';
import { planMarketSemanticBatches, marketSemanticRecordSourceRefs } from '../domain/market-research/semantic-batch-plan';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import { createMarketSemanticSkillRunner } from './market-semantic-runner';
import type { ResolvedMarketSemanticConfiguration } from './market-semantic-execution-service';
import { createMarketSemanticBatchMeter } from './market-semantic-batch-meter';
import { inspectMarketContinuation, isMarketAutomaticFlow } from '../domain/market-research/module-flow';

export const MarketBatchPreparationInputSchema = z.object({ task: MarketSemanticTaskNameSchema,
  inputSnapshotId: z.string().regex(/^market-input:[a-f0-9]{64}$/), selectionRevision: z.string().min(1).max(160), dataCutoffAt: z.string().datetime() }).strict();

/** Prepares an already-claimed step. The step worker owns its preparation
 * heartbeat; every write and final receipt recheck its database lease. */
export class MarketSemanticBatchPreparationService {
  constructor(private readonly context: PostgresQueryContext, private readonly registry: SkillRegistry) {}
  async prepareBatches(claim: MarketStepClaim, configuration: ResolvedMarketSemanticConfiguration, signal?: AbortSignal) {
    const prepared = await this.planBatches(claim, configuration, signal);
    return prepared.commit();
  }
  /** Read/compute only; the worker drains its heartbeat before invoking commit. */
  async planBatches(claim: MarketStepClaim, configuration: ResolvedMarketSemanticConfiguration, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = MarketBatchPreparationInputSchema.parse(claim.step.input);
    if (claim.step.kind !== 'prepare-model-batches' || input.task !== configuration.task) throw new MarketAgentRunConflictError();
    const steps = new PostgresMarketModuleExecutionStore(this.context), audit = new PostgresMarketAgentRunStore(this.context), snapshots = new PostgresMarketAnalysisSnapshotStore(this.context);
    const actor = { organizationId: claim.organizationId, userId: claim.createdBy };
    const view = await steps.findModuleRun({ actor, moduleRunId: claim.moduleRunId });
    const step = view?.steps.find(s => s.id === claim.stepId);
    if (!view || !step || step.latestAttemptId !== claim.attemptId || view.run.createdBy !== claim.createdBy || view.run.scope.researchId !== claim.studyId ||
      view.run.versions.configuration !== configuration.configurationVersion || view.run.versions.model !== 'market.semantic.text.v1' || view.run.status === 'cancelled' ||
      digest(claim.step) !== claim.inputHash || step.inputHash !== claim.inputHash || !step.inputRefs.some(r => r.kind === 'input' && r.id === input.inputSnapshotId)) throw new MarketAgentRunConflictError();
    const previous = view.attempts.find(a => a.id === claim.attemptId);
    if (step.status === 'succeeded' || step.status === 'empty') {
      if (previous?.status !== step.status || !previous.output) throw new MarketAgentRunConflictError();
      return { commit: async () => { signal?.throwIfAborted(); return { replayed: true, manifest: previous.output! }; } };
    }
    if (step.status !== 'running') throw new MarketAgentRunConflictError();
    const saved = await snapshots.findInput({ actor, studyId: claim.studyId, id: input.inputSnapshotId });
    if (!saved || digest(saved.snapshot.scope) !== digest(view.run.scope)) throw new MarketAgentRunConflictError();
    const records = saved.snapshot.records.map(r => MarketSemanticRecordSchema.parse((r.data as { semantic?: unknown })?.semantic));
    const sourceRefs = [...new Set(records.flatMap(marketSemanticRecordSourceRefs))].sort();
    const sources: Record<string, MarketSourceEvidence> = {};
    for (const id of sourceRefs) {
      signal?.throwIfAborted(); const source = await snapshots.findSource({ actor, studyId: claim.studyId, id });
      if (!source) throw new MarketAgentRunConflictError(); sources[id] = source.evidence;
    }
    const shapeExplanationCatalog=input.task==='market-shape-structure-explanation'?await loadMarketShapeExplanationCatalog(this.context,actor,claim.moduleRunId):undefined;
    const synthesisEvidence=input.task==='market-overview-synthesis'?await loadMarketOverviewSynthesisEvidence(this.context,actor,claim.moduleRunId,input.inputSnapshotId):input.task==='market-shape-synthesis'?await loadMarketShapeSynthesisEvidence(this.context,actor,claim.moduleRunId,input.inputSnapshotId):{};
    const runner = createMarketSemanticSkillRunner(this.context, this.registry, configuration);
    const plan = await planMarketSemanticBatches({ task: input.task, moduleRunId: claim.moduleRunId, snapshot: saved.snapshot, sources,
      selectionRevision: input.selectionRevision, dataCutoffAt: input.dataCutoffAt, configurationVersion: configuration.configurationVersion, ...(shapeExplanationCatalog?{shapeExplanationCatalog}:{}),...synthesisEvidence },
      createMarketSemanticBatchMeter(runner, configuration, signal), signal);
    const manifest = { plannerVersion: plan.plannerVersion, basisHash: plan.basisHash, task: input.task, inputSnapshotId: input.inputSnapshotId,
      expectedMemberIds: plan.expectedMemberIds, missingMemberIds: plan.missingMemberIds, rejectedMembers: plan.rejectedMembers,
      batches: plan.batches.map(b => ({ bindingId: b.bindingId, batchKey: b.input.batchKey, inputDigest: b.input.inputDigest, memberRefs: b.memberRefs })) };
    const subject = MarketExecutionSubjectSchema.parse({ kind: 'market-module-run', organizationId: claim.organizationId, studyId: claim.studyId,
      moduleRunId: claim.moduleRunId, stepId: claim.stepId, attemptId: claim.attemptId, leaseOwnerId: claim.leaseOwnerId,
      leaseGeneration: claim.leaseGeneration, dataCutoffAt: input.dataCutoffAt });
    return { commit: async () => {
    signal?.throwIfAborted();
    await this.context.transaction(async () => {
      if (isMarketAutomaticFlow(view.run)) {
        await this.context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 FOR UPDATE', [claim.moduleRunId]);
        const current = await steps.findModuleRun({ actor, moduleRunId: claim.moduleRunId });
        if (!current) throw new MarketAgentRunConflictError();
        if (!inspectMarketContinuation(current, new Date().toISOString()).currentStepKeys.includes(claim.step.stepKey)) {
          const obsolete = await steps.settleAndEnqueue({ claim, outcome: { status: 'empty', output: { superseded: true } } });
          if (obsolete.status === 'lease-lost') throw new MarketAgentRunConflictError();
          return;
        }
      }
      for (const batch of plan.batches) {
        signal?.throwIfAborted(); await audit.saveSnapshotBinding({ id: batch.bindingId, subject, inputSnapshotId: input.inputSnapshotId,
          inputProjection: batch.input, memberRefs: batch.memberRefs, sourceRefs: batch.input.sourceRefs,
          selectionRevision: input.selectionRevision, batchKey: batch.input.batchKey });
      }
      signal?.throwIfAborted();
      const receipt = await steps.settleAndEnqueue({ claim, outcome: { status: plan.batches.length ? 'succeeded' : 'empty', output: manifest },
        children: plan.batches.map(b => ({ stepKey: `model/${b.input.batchKey}`, kind: 'model-batch', subject: { task: input.task },
          input: { task: input.task, bindingId: b.bindingId, inputDigest: b.input.inputDigest }, inputRefs: [{ kind: 'input', id: input.inputSnapshotId }] })) });
      if (receipt.status === 'lease-lost') throw new MarketAgentRunConflictError();
      signal?.throwIfAborted();
    });
    return { replayed: false, manifest };
    } };
  }
}
