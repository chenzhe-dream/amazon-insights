import { z } from 'zod';

import { MarketInputRecordSchema } from '../../shared/market-analysis-contracts';
import { MarketSemanticRecordSchema } from '../../shared/market-semantic-contracts';
import type { MarketShapeSynthesisChild } from '../../shared/market-shape-synthesis-contracts';
import type { MarketExecutionActor } from '../db/market-module-execution-repository';
import { MarketExecutionConflictError } from '../db/market-module-execution-repository';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { buildMarketShapeDimensionSynthesisInput, buildMarketShapeFinalSynthesisInput, validateMarketShapeDimensionSynthesisOutput } from '../domain/market-research/shape-explanation-synthesis';
import { validateMarketSemanticInput, validateMarketShapeSynthesisOutput } from '../domain/market-research/semantic-validation';
import { canonicalJsonSha256 as digest } from '../runtime/model-request-accounting';
import { readMarketShapeExplanationFragments } from './market-shape-explanation-fragment-service';
import { loadMarketShapeExplanationCatalog } from './market-shape-explanation-input-service';

const inputId = z.string().regex(/^market-input:[a-f0-9]{64}$/);
const rawBindingSchema = z.object({
  id: z.string().uuid(), organization_id: z.string().uuid(), study_id: z.string().uuid(), module_run_id: z.string().uuid(),
  input_snapshot_id: inputId, input_digest: z.string().regex(/^[a-f0-9]{64}$/), selection_revision: z.string(), batch_key: z.string(),
  task: z.literal('market-shape-synthesis'), input_json: z.unknown(), source_refs_json: z.array(z.string()), member_refs_json: z.array(z.string()), data_cutoff_at: z.union([z.date(), z.string()]),
}).passthrough();
const auditReferenceSchema = z.object({agentRunId:z.string().uuid(),bindingId:z.string().uuid(),task:z.literal('market-shape-synthesis'),executionFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const fail = (): never => { throw new MarketExecutionConflictError(); };
const same = (left: unknown, right: unknown) => { if (digest(left) !== digest(right)) fail(); };
const exact = (actual: readonly string[], expected: readonly string[]) => {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length) fail();
  same([...actual].sort(), [...expected].sort());
};

/** Restores synthesis ancestry from immutable native rows without calling the
 * general binding reader, whose synthesis callback points back to this loader. */
export async function loadMarketShapeSynthesisChildren(context: PostgresQueryContext, actor: MarketExecutionActor, moduleRunId: string, childIds: readonly string[]) {
  return context.transaction(async () => {
    const requestedIds=z.array(z.string().min(1).max(240)).min(1).max(2_000).parse(childIds);
    exact(requestedIds,requestedIds);
    const steps = new PostgresMarketModuleExecutionStore(context), snapshots = new PostgresMarketAnalysisSnapshotStore(context), audits = new PostgresMarketAgentRunStore(context);
    const locked = await context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE', [moduleRunId, actor.organizationId]);
    if (locked.rowCount !== 1) fail();
    const foundView = await steps.findModuleRun({actor,moduleRunId});
    if (!foundView) return fail();
    const view = foundView;
    const shapeExplanationCatalog = await loadMarketShapeExplanationCatalog(context, actor, moduleRunId);
    const recovered = await readMarketShapeExplanationFragments(context, {actor,moduleRunId});
    if (!recovered.fragments || !recovered.windows.length || recovered.windows.some(window => window.status !== 'succeeded')) fail();
    const leaves = new Map(recovered.windows.flatMap(item => item.status === 'succeeded' ? [[item.windowId, item.output.section] as const] : []));
    const manifestLeaves = recovered.windows.map(item => item.windowId);
    const auditRows = await audits.listAgentRuns({actor,studyId:view.run.scope.researchId,moduleRunId});
    const visiting = new Set<string>(), verified = new Map<string, MarketShapeSynthesisChild>();

    const readSynthesis = async (snapshotId: string) => {
      const found = await snapshots.findInput({actor,studyId:view.run.scope.researchId,id:snapshotId});
      if (!found) return fail();
      const saved = found;
      if (saved.snapshot.kind !== 'overview' || saved.snapshot.records.length !== 1 || saved.snapshot.expectedRecordIds.length !== 1) fail();
      const record = saved.snapshot.records[0]; if (record.id !== saved.snapshot.expectedRecordIds[0]) fail();
      const data = MarketInputRecordSchema.shape.data.parse(record.data) as any;
      const semantic = MarketSemanticRecordSchema.parse(data.semantic);
      if (semantic.task !== 'market-shape-synthesis') return fail();
      same(saved.snapshot.scope, view.run.scope);
      if (record.id !== semantic.synthesis.nodeId) fail();
      exact(semantic.sourceRefs, shapeExplanationCatalog.source.sourceRefs);
      return {snapshot:saved.snapshot, synthesis:semantic.synthesis};
    };
    const canonicalInput = async (synthesis: any, children: readonly MarketShapeSynthesisChild[]) => {
      const expected = children.flatMap(child => child.leafWindowIds);
      const rebuilt = synthesis.mode === 'dimension-reduce'
        ? await buildMarketShapeDimensionSynthesisInput(shapeExplanationCatalog, synthesis.dimension, children, expected, () => true)
        : await buildMarketShapeFinalSynthesisInput(shapeExplanationCatalog, children, expected, () => true);
      same(rebuilt, synthesis); return rebuilt;
    };
    const authorize = async (childId:string): Promise<MarketShapeSynthesisChild> => {
      const cached = verified.get(childId); if (cached) return cached;
      if (visiting.has(childId) || visiting.size > manifestLeaves.length * 2 + 6) fail();
      const leaf = leaves.get(childId);
      if (leaf) {
        const accepted:MarketShapeSynthesisChild = Object.freeze({childId,leafWindowIds:[childId],section:leaf}); verified.set(childId, accepted); return accepted;
      }
      visiting.add(childId);
      try {
        const rows = (await context.query(`SELECT id,organization_id,study_id,module_run_id,input_snapshot_id,input_digest,selection_revision,batch_key,task,input_json,source_refs_json,member_refs_json,data_cutoff_at
          FROM market_analysis_semantic_snapshot_bindings WHERE organization_id=$1 AND study_id=$2 AND module_run_id=$3 AND task='market-shape-synthesis'
          AND input_json->'synthesis'->>'nodeId'=$4 LIMIT 2`, [actor.organizationId,view.run.scope.researchId,moduleRunId,childId])).rows;
        if (rows.length !== 1) fail(); const row = rawBindingSchema.parse(rows[0]);
        const restored = await readSynthesis(row.input_snapshot_id), synthesis = restored.synthesis;
        if (synthesis.mode !== 'dimension-reduce' || row.selection_revision !== shapeExplanationCatalog.revisionId || row.input_snapshot_id !== restored.snapshot.snapshotId) fail();
        const persistedInput = row.input_json as any;
        if (row.input_digest !== persistedInput?.inputDigest || row.task !== 'market-shape-synthesis'
          || persistedInput.task !== row.task || persistedInput.batchKey !== row.batch_key
          || persistedInput.selectionRevision !== row.selection_revision || persistedInput.contentSnapshotId !== row.input_snapshot_id
          || new Date(persistedInput.dataCutoffAt).toISOString() !== new Date(row.data_cutoff_at).toISOString()) fail();
        const {inputDigest:_ignored,...projection} = row.input_json as any; if (digest(projection) !== row.input_digest) fail();
        same(row.source_refs_json, shapeExplanationCatalog.source.sourceRefs); exact(row.member_refs_json, restored.snapshot.expectedRecordIds);
        if (new Date(row.data_cutoff_at).toISOString() !== shapeExplanationCatalog.source.dataCutoffAt) fail();
        const descendants: MarketShapeSynthesisChild[] = [];
        for (const value of synthesis.children) { const actual=await authorize(value.childId); same(actual,value); descendants.push(actual); }
        const canonical = await canonicalInput(synthesis, descendants);
        const sourceEvidenceByRef: Record<string, any> = {};
        for (const sourceRef of row.source_refs_json) {
          const source = await snapshots.findSource({actor,studyId:view.run.scope.researchId,id:sourceRef});
          if (!source) return fail();
          sourceEvidenceByRef[sourceRef] = source.evidence;
        }
        const validationBinding = {
          scope: restored.snapshot.scope, inputSnapshot: restored.snapshot, sourceEvidenceByRef,
          selectionRevision: row.selection_revision, batchKey: row.batch_key, inputDigest: row.input_digest,
          expectedIds: row.member_refs_json,
          sourceCatalog: Object.fromEntries(restored.snapshot.records.map(record => [record.id, (record.data as any).semantic])),
          shapeExplanationCatalog, shapeSynthesisChildren: descendants, shapeSynthesisExpectedLeaves: manifestLeaves,
        };
        validateMarketSemanticInput(row.input_json, validationBinding);
        const models = view.steps.filter(step => step.kind === 'model-batch' && (step.input as any)?.bindingId === row.id && (step.input as any)?.inputDigest === row.input_digest);
        if (models.length !== 1 || !models[0].latestAttemptId) return fail();
        const model = models[0], candidates = auditRows.filter(a => a.bindingId === row.id && a.attemptId === model.latestAttemptId && a.validationStatus === 'passed' && a.terminalStatus === 'succeeded');
        if (candidates.length !== 1) return fail(); const audit = candidates[0]!;
        const attempt = view.attempts.find(value => value.id === audit.attemptId);
        if (!model || !attempt || model.kind !== 'model-batch' || model.status !== 'succeeded' || model.latestAttemptId !== audit.attemptId || attempt.status !== 'succeeded') return fail();
        const modelInput = model.input as any;
        if (modelInput.task !== 'market-shape-synthesis' || modelInput.bindingId !== row.id || modelInput.inputDigest !== row.input_digest
          || !model.inputRefs.some(ref => ref.kind === 'input' && ref.id === row.input_snapshot_id)) fail();
        const reference = auditReferenceSchema.parse(attempt.output);
        if (reference.agentRunId !== audit.id || reference.bindingId !== row.id || reference.executionFingerprint !== audit.executionFingerprint || !audit.outcome?.output) return fail();
        const semanticOutput = audit.outcome.output as any;
        if (semanticOutput.task !== 'market-shape-synthesis' || semanticOutput.inputDigest !== row.input_digest || semanticOutput.batchId !== (row.input_json as any).batchId) fail();
        const checkedOutput = validateMarketShapeSynthesisOutput(row.input_json, semanticOutput, validationBinding);
        const result = validateMarketShapeDimensionSynthesisOutput(shapeExplanationCatalog, canonical, checkedOutput.result);
        if (result.nodeId !== childId || result.section.dimension !== canonical.dimension) fail();
        const accepted:MarketShapeSynthesisChild = Object.freeze({childId,leafWindowIds:[...canonical.leafWindowIds],section:result.section}); verified.set(childId, accepted); return accepted;
      } finally { visiting.delete(childId); }
    };
    const children:MarketShapeSynthesisChild[]=[];for(const id of requestedIds)children.push(await authorize(id));
    const flattened=children.flatMap(child=>child.leafWindowIds);if(new Set(flattened).size!==flattened.length||flattened.some(id=>!manifestLeaves.includes(id)))fail();
    const shapeSynthesisExpectedLeaves = manifestLeaves;
    return Object.freeze({shapeExplanationCatalog,shapeSynthesisChildren:Object.freeze(children),shapeSynthesisExpectedLeaves:Object.freeze([...shapeSynthesisExpectedLeaves])});
  });
}

export async function loadMarketShapeSynthesisEvidence(context: PostgresQueryContext, actor: MarketExecutionActor, moduleRunId: string, inputSnapshotId: string) {
 return context.transaction(async()=>{
  inputId.parse(inputSnapshotId);
  const locked=await context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE',[moduleRunId,actor.organizationId]);if(locked.rowCount!==1)fail();
  const snapshots=new PostgresMarketAnalysisSnapshotStore(context),steps=new PostgresMarketModuleExecutionStore(context);
  const maybeView=await steps.findModuleRun({actor,moduleRunId});if(!maybeView)return fail();const view=maybeView;
  const maybeFound=await snapshots.findInput({actor,studyId:view.run.scope.researchId,id:inputSnapshotId});if(!maybeFound)return fail();const found=maybeFound;
  const snapshot=found.snapshot;if(snapshot.kind!=='overview'||snapshot.records.length!==1||snapshot.expectedRecordIds.length!==1)fail();
  const record=snapshot.records[0],semantic=MarketSemanticRecordSchema.parse((MarketInputRecordSchema.shape.data.parse(record.data) as any).semantic);
  if(semantic.task!=='market-shape-synthesis')return fail();if(record.id!==semantic.synthesis.nodeId||record.id!==snapshot.expectedRecordIds[0])fail();same(snapshot.scope,view.run.scope);
  const resolved=await loadMarketShapeSynthesisChildren(context,actor,moduleRunId,semantic.synthesis.children.map(child=>child.childId));
  exact(semantic.sourceRefs,resolved.shapeExplanationCatalog.source.sourceRefs);
  same(resolved.shapeSynthesisChildren,semantic.synthesis.children);
  const expected=semantic.synthesis.children.flatMap(child=>child.leafWindowIds);
  const rebuilt=semantic.synthesis.mode==='dimension-reduce'?await buildMarketShapeDimensionSynthesisInput(resolved.shapeExplanationCatalog,semantic.synthesis.dimension,resolved.shapeSynthesisChildren,expected,()=>true):await buildMarketShapeFinalSynthesisInput(resolved.shapeExplanationCatalog,resolved.shapeSynthesisChildren,expected,()=>true);
  same(rebuilt,semantic.synthesis);if(rebuilt.mode==='final')exact(rebuilt.leafWindowIds,resolved.shapeSynthesisExpectedLeaves);
  return resolved;
 });
}
