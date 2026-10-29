import { z } from 'zod';
import { MarketSemanticRecordSchema } from '../../shared/market-semantic-contracts';
import { MARKET_SOURCE_HANDLER_VERSION, type MarketSourceEvidence } from '../../shared/market-source-contracts';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { assembleMarketThemePool } from '../domain/market-research/customer-theme-source-pool';
import { calculateMarketThemeMappingRules, MARKET_THEME_MAPPING_RULE_VERSION } from '../domain/market-research/customer-theme-mapping-rules';
import { MarketThemePoolStepInputSchema } from './market-theme-pool-step';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import type { MarketStepClaim, MarketModuleRunView, MarketExecutionActor, MarketStepDefinition, MarketExecutionAttempt } from '../db/market-module-execution-repository';

export const MarketThemeRulesStepInputSchema = z.object({ task: z.literal('customer-theme-rules'), poolAttemptId: z.string().uuid(),
  modelAttemptIds: z.array(z.string().uuid()).max(2000), preparationAttemptId: z.string().uuid().optional(), topN: z.number().int().min(0).max(2000).optional() }).strict();
function invalid(): never { throw new z.ZodError([{ code: 'custom', path: [], message: 'Theme rules require bound successful pool and model audit receipts' }]); }
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Load the original source pool and its current accepted audited batches. A
 * reconciliation claim must explicitly reference an immutable successful rules
 * attempt; its digest is replayed before any new window can be persisted. */
export async function loadMarketThemeRuleInputs(context:PostgresQueryContext,claim:MarketStepClaim,signal:AbortSignal,rulesAttemptId?:string){
  const steps = new PostgresMarketModuleExecutionStore(context);
    signal.throwIfAborted();
    const actor = { organizationId: claim.organizationId, userId: claim.createdBy };
    const view = await steps.findModuleRun({ actor, moduleRunId: claim.moduleRunId }), step = view?.steps.find(s => s.id === claim.stepId);
    if (!view || !step || claim.step.kind !== (rulesAttemptId ? 'reconcile' : 'rules') || step.status !== 'running' || step.latestAttemptId !== claim.attemptId ||
      digest(claim.step) !== claim.inputHash || step.inputHash !== claim.inputHash || view.run.createdBy !== actor.userId || view.run.scope.researchId !== claim.studyId ||
      view.run.moduleKind !== 'customer-themes' || view.run.status === 'cancelled' || view.run.versions.source !== MARKET_SOURCE_HANDLER_VERSION ||
      view.run.versions.rule !== MARKET_THEME_MAPPING_RULE_VERSION) invalid();
    const initialRulesAttempt = rulesAttemptId ? view.attempts.find(a=>a.id===rulesAttemptId) : null;
    const initialRulesStep = rulesAttemptId ? view.steps.find(s=>s.latestAttemptId===rulesAttemptId) : null;
    if(rulesAttemptId && (!claim.step.inputRefs.some(r=>r.kind==='step-output'&&r.id===rulesAttemptId) || !initialRulesAttempt || !initialRulesStep ||
      initialRulesStep.kind!=='rules' || initialRulesAttempt.stepId!==initialRulesStep.id || !['succeeded','empty'].includes(initialRulesStep.status) || initialRulesAttempt.status!==initialRulesStep.status)) invalid();
    const definition=initialRulesStep??claim.step;
    return readInputs(context,view,actor,definition,signal,initialRulesAttempt);
}

/** Read-only round assembly uses the same checked source/model lineage without
 * fabricating an active lease or accepting caller-supplied successful batches. */
export async function readMarketThemeRuleInputs(context:PostgresQueryContext,request:{actor:MarketExecutionActor;moduleRunId:string;rulesAttemptId:string},signal:AbortSignal){
  signal.throwIfAborted();
  const view=await new PostgresMarketModuleExecutionStore(context).findModuleRun({actor:request.actor,moduleRunId:request.moduleRunId});
  if(!view||view.run.moduleKind!=='customer-themes'||view.run.status==='cancelled'||view.run.versions.source!==MARKET_SOURCE_HANDLER_VERSION||view.run.versions.rule!==MARKET_THEME_MAPPING_RULE_VERSION)invalid();
  const attempt=view.attempts.find(a=>a.id===request.rulesAttemptId),step=view.steps.find(s=>s.latestAttemptId===request.rulesAttemptId);
  if(!attempt||!step||step.kind!=='rules'||attempt.stepId!==step.id||!['succeeded','empty'].includes(step.status)||attempt.status!==step.status)invalid();
  return readInputs(context,view,request.actor,step,signal,attempt);
}
async function readInputs(context:PostgresQueryContext,view:MarketModuleRunView,actor:MarketExecutionActor,definition:MarketStepDefinition,signal:AbortSignal,initialRulesAttempt:MarketExecutionAttempt|null|undefined){
  const snapshots=new PostgresMarketAnalysisSnapshotStore(context),audits=new PostgresMarketAgentRunStore(context);
  const readScope={actor,studyId:view.run.scope.researchId,moduleRunId:view.run.id};
    const input=MarketThemeRulesStepInputSchema.parse(definition.input);
    const boundAttempt = (id: string, requireDirectRef = true) => {
      if (requireDirectRef && !definition.inputRefs.some(r => r.kind === 'step-output' && r.id === id)) invalid();
      const attempt = view.attempts.find(a => a.id === id), s = view.steps.find(s => s.latestAttemptId === id);
      if (!attempt || !s || s.id !== attempt.stepId || !['succeeded', 'empty'].includes(s.status) || attempt.status !== s.status) invalid();
      return { attempt, step: s };
    };
    const poolReceipt = boundAttempt(input.poolAttemptId), original = MarketThemePoolStepInputSchema.parse(poolReceipt.step.input);
    if (poolReceipt.step.kind !== 'prepare-members' || original.phase !== 'assemble-theme-pool' || original.catalog.mappingVersion !== view.run.versions.mapping) invalid();
    async function load(id: string) {
      signal.throwIfAborted(); const saved = await snapshots.findInput({ actor, studyId: view.run.scope.researchId, id });
      if (!saved || digest(saved.snapshot.scope) !== digest(view!.run.scope)) invalid(); return saved.snapshot;
    }
    // These inputs are transitively declared by the immutable successful pool step.
    for (const id of [original.selectionInputSnapshotId, ...original.observations.map(o => o.inputSnapshotId)])
      if (!poolReceipt.step.inputRefs.some(r => r.kind === 'input' && r.id === id)) invalid();
    const selection = await load(original.selectionInputSnapshotId), sources: Record<string, MarketSourceEvidence> = {}, observations = [];
    for(const record of selection.records){const ref=z.string().parse(obj(record.data).sourceRef);if(!sources[ref]){const saved=await snapshots.findSource({actor,studyId:view.run.scope.researchId,id:ref});if(!saved)invalid();sources[ref]=saved.evidence;}}
    for (const o of original.observations) {
      if (!poolReceipt.step.inputRefs.some(r => r.kind === 'source' && r.id === o.sourceRef)) invalid();
      const source = await snapshots.findSource({ actor, studyId: view.run.scope.researchId, id: o.sourceRef }); if (!source) invalid();
      sources[o.sourceRef] = source.evidence; observations.push({ snapshot: await load(o.inputSnapshotId), sourceRef: o.sourceRef });
    }
    const failures = original.failedAttemptIds.map(id => {
      const a = view.attempts.find(a => a.id === id), s = view.steps.find(s => s.id === a?.stepId);
      if (!a || !['failed', 'interrupted'].includes(a.status) || !s || s.kind !== 'collect-customer-themes' || obj(s.input).selectionInputSnapshotId !== selection.snapshotId) invalid();
      return { asin: z.string().parse(obj(s.input).asin), attemptId: id, code: z.string().parse(obj(a.error).code) };
    });
    const poolInput = { selection, selectedAsins: original.selectedAsins, catalog: original.catalog, dataCutoffAt: original.dataCutoffAt, observations, sources, failures };
    const pool = assembleMarketThemePool(poolInput), receipt = obj(poolReceipt.attempt.output);
    if (receipt.rawInputSnapshotId !== pool.rawSnapshot.snapshotId || receipt.semanticInputSnapshotId !== pool.semanticSnapshot.snapshotId) invalid();
    if (digest(await load(pool.rawSnapshot.snapshotId)) !== digest(pool.rawSnapshot) || digest(await load(pool.semanticSnapshot.snapshotId)) !== digest(pool.semanticSnapshot)) invalid();
    if (new Set(input.modelAttemptIds).size !== input.modelAttemptIds.length) invalid();
    let preparedBindings: Map<string, string> | null = null;
    if (input.preparationAttemptId) {
      const preparation = boundAttempt(input.preparationAttemptId);
      if (preparation.step.kind !== 'prepare-model-batches' || obj(preparation.step.input).inputSnapshotId !== pool.semanticSnapshot.snapshotId ||
        obj(preparation.step.input).selectionRevision !== original.selectionRevision) invalid();
      const declared = z.array(z.object({ bindingId: z.string().uuid(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/) })).max(2000).parse(obj(preparation.attempt.output).batches);
      preparedBindings = new Map(declared.map(b => [b.bindingId, b.inputDigest])); if (preparedBindings.size !== declared.length) invalid();
    }
    const records = await audits.listAgentRuns(readScope), batches = [], auditRefs = [];
    const accepted = records.filter(a => a.task === original.catalog.task && a.terminalStatus === 'succeeded' && a.validationStatus === 'passed' &&
      view.steps.some(s => s.id === a.stepId && s.latestAttemptId === a.attemptId && s.status === 'succeeded'));
    // Native audit snapshotIds identify saved binding UUIDs, not T1 input hashes.
    // Reconciliation replays inside a run-lock transaction. That transaction
    // owns one pg client, so issue its binding reads sequentially.
    const bindings = new Map<string, NonNullable<Awaited<ReturnType<typeof audits.findSnapshotBinding>>>>();
    for (const a of accepted) {
      const binding = await audits.findSnapshotBinding({ ...readScope, bindingId: a.bindingId });
      if (!binding) invalid(); bindings.set(a.bindingId, binding);
    }
    const matching = accepted.filter(a => bindings.get(a.bindingId)?.inputSnapshotId === pool.semanticSnapshot.snapshotId);
    // Callers may not omit an already accepted member batch to manufacture a result.
    if (digest(matching.map(a => a.attemptId).sort()) !== digest([...input.modelAttemptIds].sort())) invalid();
    for (const id of input.modelAttemptIds) {
      const model = boundAttempt(id, preparedBindings === null), audit = matching.find(a => a.attemptId === id), out = obj(model.attempt.output);
      if (model.step.kind !== 'model-batch' || !audit || audit.task !== original.catalog.task || audit.id !== out.agentRunId || audit.bindingId !== out.bindingId ||
        audit.executionFingerprint !== out.executionFingerprint || !audit.outcome?.output || audit.outcome.terminalStatus !== 'succeeded' || audit.outcome.validationStatus !== 'passed') invalid();
      if (obj(model.step.input).bindingId !== audit.bindingId || (preparedBindings && preparedBindings.get(audit.bindingId) !== obj(model.step.input).inputDigest)) invalid();
      const binding = bindings.get(audit.bindingId);
      if (!binding || binding.inputSnapshotId !== pool.semanticSnapshot.snapshotId || binding.selectionRevision !== original.selectionRevision || binding.dataCutoffAt !== original.dataCutoffAt) invalid();
      batches.push({ input: binding.inputProjection, output: audit.outcome.output, binding: { scope: view.run.scope, inputSnapshot: pool.semanticSnapshot,
        sourceEvidenceByRef: sources, selectionRevision: binding.selectionRevision, batchKey: binding.batchKey, inputDigest: binding.inputDigest, expectedIds: binding.memberRefs,
        sourceCatalog: Object.fromEntries(pool.semanticSnapshot.records.map(r => [r.id, MarketSemanticRecordSchema.parse(obj(r.data).semantic)])) } });
      auditRefs.push({ agentRunId: audit.id, attemptId: id, bindingId: binding.id, executionFingerprint: audit.executionFingerprint });
    }
    if(initialRulesAttempt){
      const initial=calculateMarketThemeMappingRules({poolInput,batches,topN:input.topN,originalRules:view.run.versions.planner==='market-theme-flow/rules-v3'});
      const saved=await load(z.string().parse(obj(initialRulesAttempt.output).inputSnapshotId));
      const summary=obj(saved.records.find(r=>r.id==='summary')?.data);
      if(obj(initialRulesAttempt.output).resultHash!==initial.resultHash || summary.resultHash!==initial.resultHash ||
        saved.ruleVersion!==`${MARKET_THEME_MAPPING_RULE_VERSION}:${initial.resultHash}`) invalid();
    }
    return {input,view,poolInput,pool,receipt,original,batches,auditRefs,initialRulesAttempt};
}
