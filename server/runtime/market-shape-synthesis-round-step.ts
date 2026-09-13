import { MARKET_SHAPE_EXPLANATION_DIMENSIONS } from '../../shared/market-shape-explanation-contracts';
import type { MarketShapeDimensionSynthesisInput, MarketShapeFinalSynthesisInput } from '../../shared/market-shape-synthesis-contracts';
import { MarketInputRecordSchema, type MarketJsonValue } from '../../shared/market-analysis-contracts';
import type { MarketSourceEvidence } from '../../shared/market-source-contracts';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { loadMarketShapeSynthesisChildren } from '../services/market-shape-synthesis-input-service';
import { isMarketShapeExplanationFlow } from '../domain/market-research/shape-explanation-flow';
import { MarketShapeSynthesisRoundInputSchema, MarketShapeSynthesisRoundManifestSchema, marketShapeSynthesisRoundDefinition, marketShapeSynthesisPreparation, inspectMarketShapeExplanationContinuation } from '../domain/market-research/shape-explanation-continuation';
import { buildMarketShapeFinalSynthesisInput, planMarketShapeDimensionSynthesisRound, MarketShapeSynthesisRequestTooLargeError } from '../domain/market-research/shape-explanation-synthesis';
import { createMarketInputSnapshot } from '../domain/market-research/snapshot';
import { planMarketSemanticBatches } from '../domain/market-research/semantic-batch-plan';
import type { SkillRegistry } from '../skills/registry';
import type { ResolvedMarketSemanticConfiguration } from './market-semantic-execution-service';
import { createMarketSemanticSkillRunner } from './market-semantic-runner';
import { createMarketSemanticBatchMeter } from './market-semantic-batch-meter';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import type { MarketStepHandler } from './market-module-step-worker';

const task = 'market-shape-synthesis' as const;
type SynthesisInput = MarketShapeDimensionSynthesisInput | MarketShapeFinalSynthesisInput;
const json = (value: unknown): MarketJsonValue => MarketInputRecordSchema.shape.data.parse(JSON.parse(JSON.stringify(value)));
function invalid(): never { throw new TypeError('Shape synthesis round differs from its current saved evidence'); }

/** Complete rounds use only recovered successful nodes. Computation and metering
 * remain outside the settlement transaction; snapshots and children commit once. */
export function createMarketShapeSynthesisRoundStep(context: PostgresQueryContext, options: { registry: SkillRegistry; configuration: ResolvedMarketSemanticConfiguration }): MarketStepHandler {
 return async ({claim, signal}) => {
  signal.throwIfAborted();
  const actor = {organizationId: claim.organizationId, userId: claim.createdBy};
  const view = await new PostgresMarketModuleExecutionStore(context).findModuleRun({actor, moduleRunId: claim.moduleRunId});
  const step = view?.steps.find(value => value.id === claim.stepId);
  if (!view || !step || !isMarketShapeExplanationFlow(view.run) || view.run.status === 'cancelled'
   || step.status !== 'running' || step.latestAttemptId !== claim.attemptId || step.inputHash !== claim.inputHash || digest(claim.step) !== claim.inputHash
   || options.configuration.task !== task || options.configuration.configurationVersion !== view.run.versions.configuration) invalid();
  const input = MarketShapeSynthesisRoundInputSchema.parse(claim.step.input);
  if (digest(marketShapeSynthesisRoundDefinition(input)) !== claim.inputHash
   || !inspectMarketShapeExplanationContinuation(view, new Date().toISOString()).currentStepKeys.includes(step.stepKey)) invalid();
  const evidence = await loadMarketShapeSynthesisChildren(context, actor, claim.moduleRunId, input.childIds);
  const catalog = evidence.shapeExplanationCatalog, children = evidence.shapeSynthesisChildren;
  const leaves = children.flatMap(child => child.leafWindowIds);
  if (new Set(leaves).size !== leaves.length || digest([...leaves].sort()) !== digest([...evidence.shapeSynthesisExpectedLeaves].sort())) invalid();
  const store = new PostgresMarketAnalysisSnapshotStore(context), sources: Record<string, MarketSourceEvidence> = {};
  for (const id of catalog.source.sourceRefs) {
   signal.throwIfAborted(); const source = await store.findSource({actor, studyId: claim.studyId, id});
   if (!source) invalid(); sources[id] = source.evidence;
  }
  const snapshotFor = (synthesis: SynthesisInput) => {
   const input = {scope: view.run.scope, kind: 'overview' as const, sourceVersion: catalog.version, ruleVersion: 'shape-synthesis/v1', collectedAt: catalog.source.dataCutoffAt,
    expectedRecordIds: [synthesis.nodeId], records: [{id: synthesis.nodeId, scope: view.run.scope, data: json({semantic: {task, synthesis, sourceRefs: catalog.source.sourceRefs}})}]};
   return {input, snapshot: createMarketInputSnapshot(input)};
  };
  const meter = createMarketSemanticBatchMeter(createMarketSemanticSkillRunner(context, options.registry, options.configuration), options.configuration, signal);
  const fits = async (synthesis: SynthesisInput) => {
   const plan = await planMarketSemanticBatches({task, moduleRunId: claim.moduleRunId, snapshot: snapshotFor(synthesis).snapshot, sources,
    selectionRevision: catalog.revisionId, configurationVersion: options.configuration.configurationVersion, dataCutoffAt: catalog.source.dataCutoffAt,
    ...evidence, shapeSynthesisChildren: synthesis.children}, meter, signal);
   return plan.batches.length === 1 && !plan.rejectedMembers.length && !plan.missingMemberIds.length;
  };
  const nodes: SynthesisInput[] = [], carriedChildIds: string[] = [];
  try {
   if (MARKET_SHAPE_EXPLANATION_DIMENSIONS.every(dimension => children.filter(child => child.section.dimension === dimension).length === 1)) {
    nodes.push(await buildMarketShapeFinalSynthesisInput(catalog, children, evidence.shapeSynthesisExpectedLeaves, fits, signal));
   } else {
    for (const dimension of MARKET_SHAPE_EXPLANATION_DIMENSIONS) {
     const group = children.filter(child => child.section.dimension === dimension); if (!group.length) invalid();
     if (group.length === 1) { carriedChildIds.push(group[0].childId); continue; }
     const round = await planMarketShapeDimensionSynthesisRound(catalog, dimension, group, group.flatMap(child => child.leafWindowIds), fits, signal);
     nodes.push(...round.mergeInputs); carriedChildIds.push(...round.carried.map(child => child.childId));
    }
    if (!nodes.length || nodes.length + carriedChildIds.length >= children.length) invalid();
   }
  } catch (error) {
   if (!(error instanceof MarketShapeSynthesisRequestTooLargeError)) throw error;
   return {kind: 'settlement', value: {outcome: {status: 'failed', error: {code: 'governance', retryable: false},
    diagnostic: {reason: 'request-too-large', phase: 'shape-synthesis', preservedChildIds: input.childIds}}}};
  }
  const prepared = nodes.map(synthesis => ({synthesis, ...snapshotFor(synthesis)}));
  const manifest = MarketShapeSynthesisRoundManifestSchema.parse({manifestVersion: 'shape-synthesis-round/v1', windowAttemptId: input.windowAttemptId,
   basisAttemptIds: input.basisAttemptIds, childIds: input.childIds, carriedChildIds,
   nodes: prepared.map(({synthesis, snapshot}) => ({nodeId: synthesis.nodeId, inputSnapshotId: snapshot.snapshotId, leafWindowIds: synthesis.leafWindowIds, dimension: synthesis.dimension, mode: synthesis.mode}))});
  signal.throwIfAborted();
  return {kind: 'settlement', value: {outcome: {status: 'succeeded', output: json(manifest)}, inputs: prepared.map(value => json(value.input)),
   children: prepared.map(value => marketShapeSynthesisPreparation(value.snapshot.snapshotId, catalog.revisionId, catalog.source.dataCutoffAt))}};
 };
}
