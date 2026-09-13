import {MarketModuleIdSchema} from '../../shared/market-module-contracts';
import {MarketExecutionConflictError,type MarketExecutionActor} from '../db/market-module-execution-repository';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import {inspectMarketOverviewContinuation} from '../domain/market-research/overview-flow';
import {buildMarketOverviewSynthesisBasis} from '../domain/market-research/overview-synthesis-basis';
import {readMarketOverviewReport} from '../runtime/market-overview-report-reader';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';

/** Read-only promotion of frozen, audited window results. The pure builder
 * checks coverage and content; this loader proves authorization and provenance.
 * Historical mode is for inspection, never authority to schedule new work. */
async function restoreMarketOverviewSynthesisBasis(
  context:PostgresQueryContext,
  input:{actor:MarketExecutionActor;moduleRunId:string;reportAttemptId:string;mode:'current'|'historical'},
  signal:AbortSignal,
){
  MarketModuleIdSchema.parse(input.moduleRunId);
  MarketModuleIdSchema.parse(input.reportAttemptId);
  if(input.mode!=='current'&&input.mode!=='historical')throw new TypeError('Invalid overview synthesis read mode');
  return context.transaction(async()=>{
    signal.throwIfAborted();
    const lock=await context.query(`SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2
      AND EXISTS(SELECT 1 FROM users WHERE id=$3 AND organization_id=$2 AND status='active') FOR SHARE`,
      [input.moduleRunId,input.actor.organizationId,input.actor.userId]);
    if(!lock.rowCount)return null;
    const view=await new PostgresMarketModuleExecutionStore(context).findModuleRun({actor:input.actor,moduleRunId:input.moduleRunId});
    const attempt=view?.attempts.find(a=>a.id===input.reportAttemptId);
    const step=view?.steps.find(s=>s.id===attempt?.stepId);
    if(!view||!attempt||!step||step.kind!=='report'||!['succeeded','empty'].includes(attempt.status))throw new MarketExecutionConflictError();
    if(input.mode==='current'&&(view.run.status==='cancelled'||step.latestAttemptId!==attempt.id
      ||!inspectMarketOverviewContinuation(view,new Date().toISOString()).currentStepKeys.includes(step.stepKey)))throw new MarketExecutionConflictError();
    const restored=await readMarketOverviewReport(context,view,step,signal);
    if(digest(restored.report)!==digest(attempt.output)||restored.report.phase!=='window-results'
      ||restored.report.windowStatus!=='complete'||!restored.synthesisSource)throw new MarketExecutionConflictError();
    const basis=buildMarketOverviewSynthesisBasis(restored.synthesisSource);
    signal.throwIfAborted();
    return {basis,sourceReport:{report:restored.report,numbers:restored.numbers,semantic:restored.semantic},provenance:{moduleRunId:view.run.id,reportAttemptId:attempt.id,reportHash:restored.report.reportHash,mode:input.mode}};
  });
}

/** Preserve the original evidence-only API; report metadata is not validation input. */
export async function loadMarketOverviewSynthesisBasis(context:PostgresQueryContext,input:Parameters<typeof restoreMarketOverviewSynthesisBasis>[1],signal:AbortSignal){
  const restored=await restoreMarketOverviewSynthesisBasis(context,input,signal);
  return restored?{basis:restored.basis,provenance:restored.provenance}:null;
}

import type {MarketOverviewSynthesisBasis} from '../../shared/market-overview-synthesis-contracts';
export function marketOverviewSynthesisSourceRefs(basis:MarketOverviewSynthesisBasis):string[]{return [...new Set([...basis.metrics,...basis.facts,...basis.gaps].flatMap(value=>value.sourceRefs))].sort();}
import { z } from 'zod';

import { MarketInputRecordSchema } from '../../shared/market-analysis-contracts';
import {MarketOverviewSynthesisInputSchema,MarketOverviewSynthesisOutputSchema, MarketSemanticRecordSchema } from '../../shared/market-semantic-contracts';
import type {MarketOverviewSynthesisInput, MarketOverviewSynthesisChild } from '../../shared/market-overview-reduction-contracts';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { buildMarketOverviewDimensionSynthesisInput, buildMarketOverviewFinalSynthesisInput, createMarketOverviewSynthesisChildren, createMarketOverviewSynthesisChild, validateMarketOverviewDimensionSynthesisOutput } from '../domain/market-research/overview-synthesis';
import { validateMarketSemanticInput, validateMarketOverviewSynthesisOutput } from '../domain/market-research/semantic-validation';

import type {MarketSourceEvidence} from '../../shared/market-source-contracts';
const obj=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const inputId = z.string().regex(/^market-input:[a-f0-9]{64}$/);
const rawBindingSchema = z.object({
  id: z.string().uuid(), organization_id: z.string().uuid(), study_id: z.string().uuid(), module_run_id: z.string().uuid(),
  input_snapshot_id: inputId, input_digest: z.string().regex(/^[a-f0-9]{64}$/), selection_revision: z.string(), batch_key: z.string(),
  task: z.literal('market-overview-synthesis'), input_json: z.unknown(), source_refs_json: z.array(z.string()), member_refs_json: z.array(z.string()), data_cutoff_at: z.union([z.date(), z.string()]),
}).passthrough();
const auditReferenceSchema = z.object({agentRunId:z.string().uuid(),bindingId:z.string().uuid(),task:z.literal('market-overview-synthesis'),executionFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const fail = (): never => { throw new MarketExecutionConflictError(); };
const same = (left: unknown, right: unknown) => { if (digest(left) !== digest(right)) fail(); };
const exact = (actual: readonly string[], expected: readonly string[]) => {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length) fail();
  same([...actual].sort(), [...expected].sort());
};

/** Restores synthesis ancestry from immutable native rows without calling the
 * general binding reader, whose synthesis callback points back to this loader. */
async function restoreMarketOverviewSynthesisChildren(context: PostgresQueryContext, actor: MarketExecutionActor, moduleRunId: string, sourceReportAttemptId:string, childIds: readonly string[], signal:AbortSignal=new AbortController().signal) {
  return context.transaction(async () => {
    signal.throwIfAborted();
    const requestedIds=z.array(z.string().min(1).max(240)).min(1).max(2_000).parse(childIds);
    exact(requestedIds,requestedIds);
    const steps = new PostgresMarketModuleExecutionStore(context), snapshots = new PostgresMarketAnalysisSnapshotStore(context), audits = new PostgresMarketAgentRunStore(context);
    const locked = await context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE', [moduleRunId, actor.organizationId]);
    if (locked.rowCount !== 1) fail();
    const foundView = await steps.findModuleRun({actor,moduleRunId});
    if (!foundView) return fail();
    const view = foundView;
    const recovered=await restoreMarketOverviewSynthesisBasis(context,{actor,moduleRunId,reportAttemptId:sourceReportAttemptId,mode:'historical'},signal);
    if(!recovered)return fail();
    const overviewSynthesisBasis=recovered.basis;
    const leaves=new Map(createMarketOverviewSynthesisChildren(overviewSynthesisBasis).map(child=>[child.childId,child]));
    const manifestLeaves=overviewSynthesisBasis.leaves.map(leaf=>leaf.leafId);
    const auditRows = await audits.listAgentRuns({actor,studyId:view.run.scope.researchId,moduleRunId});
    const visiting = new Set<string>(), verified = new Map<string, MarketOverviewSynthesisChild>();

    const readSynthesis = async (snapshotId: string) => {
      const found = await snapshots.findInput({actor,studyId:view.run.scope.researchId,id:snapshotId});
      if (!found) return fail();
      const saved = found;
      if (saved.snapshot.kind !== 'overview' || saved.snapshot.records.length !== 1 || saved.snapshot.expectedRecordIds.length !== 1) fail();
      const record = saved.snapshot.records[0]; if (record.id !== saved.snapshot.expectedRecordIds[0]) fail();
      const data = obj(MarketInputRecordSchema.shape.data.parse(record.data));
      const semantic = MarketSemanticRecordSchema.parse(data.semantic);
      if (semantic.task !== 'market-overview-synthesis') return fail();
      if(semantic.sourceReportAttemptId!==sourceReportAttemptId)fail();
      same(saved.snapshot.scope, view.run.scope);
      if (record.id !== semantic.synthesis.nodeId) fail();
      exact(semantic.sourceRefs, marketOverviewSynthesisSourceRefs(overviewSynthesisBasis));
      return {snapshot:saved.snapshot, synthesis:semantic.synthesis};
    };
    const canonicalInput = async (synthesis: MarketOverviewSynthesisInput, children: readonly MarketOverviewSynthesisChild[]) => {
      const expected = children.flatMap(child => child.leafSectionIds);
      const rebuilt = synthesis.mode === 'dimension-reduce'
        ? await buildMarketOverviewDimensionSynthesisInput(overviewSynthesisBasis, synthesis.dimensionId, children, expected, () => true)
        : await buildMarketOverviewFinalSynthesisInput(overviewSynthesisBasis, children, expected, () => true);
      same(rebuilt, synthesis); return rebuilt;
    };
    const authorize = async (childId:string): Promise<MarketOverviewSynthesisChild> => {
      signal.throwIfAborted();
      const cached = verified.get(childId); if (cached) return cached;
      if (visiting.has(childId) || visiting.size > manifestLeaves.length * 2 + 6) fail();
      const leaf = leaves.get(childId);
      if (leaf) {
        const accepted:MarketOverviewSynthesisChild = leaf; verified.set(childId, accepted); return accepted;
      }
      visiting.add(childId);
      try {
        const rows = (await context.query(`SELECT id,organization_id,study_id,module_run_id,input_snapshot_id,input_digest,selection_revision,batch_key,task,input_json,source_refs_json,member_refs_json,data_cutoff_at
          FROM market_analysis_semantic_snapshot_bindings WHERE organization_id=$1 AND study_id=$2 AND module_run_id=$3 AND task='market-overview-synthesis'
          AND input_json->'synthesis'->>'nodeId'=$4 LIMIT 2`, [actor.organizationId,view.run.scope.researchId,moduleRunId,childId])).rows;
        if (rows.length !== 1) fail(); const row = rawBindingSchema.parse(rows[0]);
        const restored = await readSynthesis(row.input_snapshot_id), synthesis = restored.synthesis;
        if (synthesis.mode !== 'dimension-reduce' || row.selection_revision !== overviewSynthesisBasis.selectionRevision || row.input_snapshot_id !== restored.snapshot.snapshotId) fail();
        const persistedInput = MarketOverviewSynthesisInputSchema.parse(row.input_json);
        if (row.input_digest !== persistedInput?.inputDigest || row.task !== 'market-overview-synthesis'
          || persistedInput.task !== row.task || persistedInput.batchKey !== row.batch_key
          || persistedInput.selectionRevision !== row.selection_revision || persistedInput.contentSnapshotId !== row.input_snapshot_id
          || new Date(persistedInput.dataCutoffAt).toISOString() !== new Date(row.data_cutoff_at).toISOString()) fail();
        const {inputDigest,...projection} = persistedInput; if(inputDigest!==row.input_digest)fail(); if (digest(projection) !== row.input_digest) fail();
        same(row.source_refs_json, marketOverviewSynthesisSourceRefs(overviewSynthesisBasis)); exact(row.member_refs_json, restored.snapshot.expectedRecordIds);
        if (new Date(row.data_cutoff_at).toISOString() !== overviewSynthesisBasis.dataCutoffAt) fail();
        const descendants: MarketOverviewSynthesisChild[] = [];
        for (const value of synthesis.children) { const actual=await authorize(value.childId); same(actual,value); descendants.push(actual); }
        const canonical = await canonicalInput(synthesis, descendants);
        const sourceEvidenceByRef: Record<string,MarketSourceEvidence> = {};
        for (const sourceRef of row.source_refs_json) {
          signal.throwIfAborted();
          const source = await snapshots.findSource({actor,studyId:view.run.scope.researchId,id:sourceRef});
          if (!source) return fail();
          sourceEvidenceByRef[sourceRef] = source.evidence;
        }
        const validationBinding = {
          scope: restored.snapshot.scope, inputSnapshot: restored.snapshot, sourceEvidenceByRef,
          selectionRevision: row.selection_revision, batchKey: row.batch_key, inputDigest: row.input_digest,
          expectedIds: row.member_refs_json,
          sourceCatalog: Object.fromEntries(restored.snapshot.records.map(record => [record.id, MarketSemanticRecordSchema.parse(obj(record.data).semantic)])),
          overviewSynthesisBasis, overviewSynthesisChildren: descendants, overviewSynthesisExpectedLeaves: synthesis.leafSectionIds,
        };
        validateMarketSemanticInput(row.input_json, validationBinding);
        const models = view.steps.filter(step => step.kind === 'model-batch' && obj(step.input).bindingId === row.id && obj(step.input).inputDigest === row.input_digest);
        if (models.length !== 1 || !models[0].latestAttemptId) return fail();
        const model = models[0], candidates = auditRows.filter(a => a.bindingId === row.id && a.attemptId === model.latestAttemptId && a.validationStatus === 'passed' && a.terminalStatus === 'succeeded');
        if (candidates.length !== 1) return fail(); const audit = candidates[0]!;
        const attempt = view.attempts.find(value => value.id === audit.attemptId);
        if (!model || !attempt || model.kind !== 'model-batch' || model.status !== 'succeeded' || model.latestAttemptId !== audit.attemptId || attempt.status !== 'succeeded') return fail();
        const modelInput = obj(model.input);
        if (modelInput.task !== 'market-overview-synthesis' || modelInput.bindingId !== row.id || modelInput.inputDigest !== row.input_digest
          || !model.inputRefs.some(ref => ref.kind === 'input' && ref.id === row.input_snapshot_id)) fail();
        const reference = auditReferenceSchema.parse(attempt.output);
        if (reference.agentRunId !== audit.id || reference.bindingId !== row.id || reference.executionFingerprint !== audit.executionFingerprint || !audit.outcome?.output) return fail();
        const semanticOutput = MarketOverviewSynthesisOutputSchema.parse(audit.outcome.output);
        if (semanticOutput.task !== 'market-overview-synthesis' || semanticOutput.inputDigest !== row.input_digest || semanticOutput.batchId !== persistedInput.batchId) fail();
        const checkedOutput = validateMarketOverviewSynthesisOutput(row.input_json, semanticOutput, validationBinding);
        const result = validateMarketOverviewDimensionSynthesisOutput(canonical, checkedOutput.result);
        if(canonical.nodeId!==childId)fail();
        const accepted=createMarketOverviewSynthesisChild(canonical,result); verified.set(childId, accepted); return accepted;
      } finally { visiting.delete(childId); }
    };
    const children:MarketOverviewSynthesisChild[]=[];for(const id of requestedIds)children.push(await authorize(id));
    const flattened=children.flatMap(child=>child.leafSectionIds);if(new Set(flattened).size!==flattened.length||flattened.some(id=>!manifestLeaves.includes(id)))fail();
    const overviewSynthesisExpectedLeaves = flattened;
    signal.throwIfAborted();
    return Object.freeze({evidence:Object.freeze({overviewSynthesisBasis,overviewSynthesisChildren:Object.freeze(children),overviewSynthesisExpectedLeaves:Object.freeze([...overviewSynthesisExpectedLeaves])}),sourceReport:recovered.sourceReport});
  });
}

export async function loadMarketOverviewSynthesisChildren(context:PostgresQueryContext,actor:MarketExecutionActor,moduleRunId:string,sourceReportAttemptId:string,childIds:readonly string[],signal:AbortSignal=new AbortController().signal){
  return (await restoreMarketOverviewSynthesisChildren(context,actor,moduleRunId,sourceReportAttemptId,childIds,signal)).evidence;
}

export async function loadMarketOverviewSynthesisEvidence(context:PostgresQueryContext,actor:MarketExecutionActor,moduleRunId:string,inputSnapshotId:string,signal:AbortSignal=new AbortController().signal){
  return (await loadMarketOverviewSynthesisEvidenceWithSourceReport(context,actor,moduleRunId,inputSnapshotId,signal)).evidence;
}

/** Metadata stays outside the evidence object used by bounded semantic validation. */
export async function loadMarketOverviewSynthesisEvidenceWithSourceReport(context: PostgresQueryContext, actor: MarketExecutionActor, moduleRunId: string, inputSnapshotId: string, signal:AbortSignal=new AbortController().signal) {
 return context.transaction(async()=>{
  signal.throwIfAborted();
  inputId.parse(inputSnapshotId);
  const locked=await context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE',[moduleRunId,actor.organizationId]);if(locked.rowCount!==1)fail();
  const snapshots=new PostgresMarketAnalysisSnapshotStore(context),steps=new PostgresMarketModuleExecutionStore(context);
  const maybeView=await steps.findModuleRun({actor,moduleRunId});if(!maybeView)return fail();const view=maybeView;
  const maybeFound=await snapshots.findInput({actor,studyId:view.run.scope.researchId,id:inputSnapshotId});if(!maybeFound)return fail();const found=maybeFound;
  const snapshot=found.snapshot;if(snapshot.kind!=='overview'||snapshot.records.length!==1||snapshot.expectedRecordIds.length!==1)fail();
  const record=snapshot.records[0],semantic=MarketSemanticRecordSchema.parse((obj(MarketInputRecordSchema.shape.data.parse(record.data))).semantic);
  if(semantic.task!=='market-overview-synthesis')return fail();if(record.id!==semantic.synthesis.nodeId||record.id!==snapshot.expectedRecordIds[0])fail();same(snapshot.scope,view.run.scope);
  const recovered=await restoreMarketOverviewSynthesisChildren(context,actor,moduleRunId,semantic.sourceReportAttemptId,semantic.synthesis.children.map(child=>child.childId),signal),resolved=recovered.evidence;
  exact(semantic.sourceRefs,marketOverviewSynthesisSourceRefs(resolved.overviewSynthesisBasis));
  same(resolved.overviewSynthesisChildren,semantic.synthesis.children);
  const expected=semantic.synthesis.children.flatMap(child=>child.leafSectionIds);
  const rebuilt=semantic.synthesis.mode==='dimension-reduce'?await buildMarketOverviewDimensionSynthesisInput(resolved.overviewSynthesisBasis,semantic.synthesis.dimensionId,resolved.overviewSynthesisChildren,expected,()=>true):await buildMarketOverviewFinalSynthesisInput(resolved.overviewSynthesisBasis,resolved.overviewSynthesisChildren,expected,()=>true);
  same(rebuilt,semantic.synthesis);if(rebuilt.mode==='final')exact(rebuilt.leafSectionIds,resolved.overviewSynthesisExpectedLeaves);
  signal.throwIfAborted();
  return Object.freeze({evidence:resolved,sourceReport:recovered.sourceReport});
 });
}
