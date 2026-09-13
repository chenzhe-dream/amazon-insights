import type {MarketOverviewSynthesisInput} from '../../shared/market-overview-reduction-contracts';
import { MarketInputRecordSchema, type MarketJsonValue } from '../../shared/market-analysis-contracts';
import type { MarketSourceEvidence } from '../../shared/market-source-contracts';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { loadMarketOverviewSynthesisChildren,marketOverviewSynthesisSourceRefs } from '../services/market-overview-synthesis-input-service';
import {inspectMarketOverviewContinuation,MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION} from '../domain/market-research/overview-flow';
import { MarketOverviewSynthesisRoundInputSchema, MarketOverviewSynthesisRoundManifestSchema, marketOverviewSynthesisRoundDefinition, marketOverviewSynthesisPreparation } from '../domain/market-research/overview-synthesis-continuation';
import { buildMarketOverviewFinalSynthesisInput, planMarketOverviewDimensionSynthesisRound, MarketOverviewSynthesisRequestTooLargeError } from '../domain/market-research/overview-synthesis';
import { createMarketInputSnapshot } from '../domain/market-research/snapshot';
import { planMarketSemanticBatches } from '../domain/market-research/semantic-batch-plan';
import type { SkillRegistry } from '../skills/registry';
import type { ResolvedMarketSemanticConfiguration } from './market-semantic-execution-service';
import { createMarketSemanticSkillRunner } from './market-semantic-runner';
import { createMarketSemanticBatchMeter } from './market-semantic-batch-meter';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import type { MarketStepHandler } from './market-module-step-worker';

const task = 'market-overview-synthesis' as const;
type SynthesisInput = MarketOverviewSynthesisInput;
const json = (value: unknown): MarketJsonValue => MarketInputRecordSchema.shape.data.parse(JSON.parse(JSON.stringify(value)));
function invalid(): never { throw new TypeError('Overview synthesis round differs from its current saved evidence'); }

/** Complete rounds use only recovered successful nodes. Computation and metering
 * remain outside the settlement transaction; snapshots and children commit once. */
export function createMarketOverviewSynthesisRoundStep(context: PostgresQueryContext, options: { registry: SkillRegistry; configuration: ResolvedMarketSemanticConfiguration }): MarketStepHandler {
 return async ({claim, signal}) => {
  signal.throwIfAborted();
  const actor = {organizationId: claim.organizationId, userId: claim.createdBy};
  const view = await new PostgresMarketModuleExecutionStore(context).findModuleRun({actor, moduleRunId: claim.moduleRunId});
  const step = view?.steps.find(value => value.id === claim.stepId);
  if (!view || !step || !((view.run.params as {flow?:string}).flow===MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION) || view.run.status === 'cancelled'
   || step.status !== 'running' || step.latestAttemptId !== claim.attemptId || step.inputHash !== claim.inputHash || digest(claim.step) !== claim.inputHash
   || options.configuration.task !== task || options.configuration.configurationVersion !== view.run.versions.configuration) invalid();
  const input = MarketOverviewSynthesisRoundInputSchema.parse(claim.step.input);
  if (digest(marketOverviewSynthesisRoundDefinition(input)) !== claim.inputHash
   || !inspectMarketOverviewContinuation(view, new Date().toISOString()).currentStepKeys.includes(step.stepKey)) invalid();
  const evidence = await loadMarketOverviewSynthesisChildren(context, actor, claim.moduleRunId, input.sourceReportAttemptId, input.childIds);
  const catalog = evidence.overviewSynthesisBasis, children = evidence.overviewSynthesisChildren;
  const leaves = children.flatMap(child => child.leafSectionIds);
  if (new Set(leaves).size !== leaves.length || digest([...leaves].sort()) !== digest([...evidence.overviewSynthesisExpectedLeaves].sort())) invalid();
  const store = new PostgresMarketAnalysisSnapshotStore(context), sources: Record<string, MarketSourceEvidence> = {};
  for (const id of marketOverviewSynthesisSourceRefs(catalog)) {
   signal.throwIfAborted(); const source = await store.findSource({actor, studyId: claim.studyId, id});
   if (!source) invalid(); sources[id] = source.evidence;
  }
  const snapshotFor = (synthesis: SynthesisInput) => {
   const snapshotInput = {scope: view.run.scope, kind: 'overview' as const, sourceVersion: catalog.version, ruleVersion: 'overview-synthesis/v1', collectedAt: catalog.dataCutoffAt,
    expectedRecordIds: [synthesis.nodeId], records: [{id: synthesis.nodeId, scope: view.run.scope, data: json({semantic: {task, synthesis, sourceRefs: marketOverviewSynthesisSourceRefs(catalog),sourceReportAttemptId:input.sourceReportAttemptId}})}]};
   return {input:snapshotInput, snapshot: createMarketInputSnapshot(snapshotInput)};
  };
  const meter = createMarketSemanticBatchMeter(createMarketSemanticSkillRunner(context, options.registry, options.configuration), options.configuration, signal);
  const fits = async (synthesis: SynthesisInput) => {
   const plan = await planMarketSemanticBatches({task, moduleRunId: claim.moduleRunId, snapshot: snapshotFor(synthesis).snapshot, sources,
    selectionRevision: catalog.selectionRevision, configurationVersion: options.configuration.configurationVersion, dataCutoffAt: catalog.dataCutoffAt,
    ...evidence, overviewSynthesisChildren: synthesis.children,overviewSynthesisExpectedLeaves:synthesis.leafSectionIds}, meter, signal);
   return plan.batches.length === 1 && !plan.rejectedMembers.length && !plan.missingMemberIds.length;
  };
  const nodes: SynthesisInput[] = [], carriedChildIds: string[] = [];
  try {
   if (catalog.dimensions.map(d=>d.id).every(dimension => children.filter(child => child.section.dimensionId === dimension).length === 1)) {
    nodes.push(await buildMarketOverviewFinalSynthesisInput(catalog, children, evidence.overviewSynthesisExpectedLeaves, fits, signal));
   } else {
    for (const dimension of catalog.dimensions.map(d=>d.id)) {
     const group = children.filter(child => child.section.dimensionId === dimension); if (!group.length) invalid();
     if (group.length === 1) { carriedChildIds.push(group[0].childId); continue; }
     const round = await planMarketOverviewDimensionSynthesisRound(catalog, dimension, group, group.flatMap(child => child.leafSectionIds), fits, signal);
     nodes.push(...round.inputs); carriedChildIds.push(...round.carry.map(child => child.childId));
    }
    if (!nodes.length || nodes.length + carriedChildIds.length >= children.length) invalid();
   }
  } catch (error) {
   if (!(error instanceof MarketOverviewSynthesisRequestTooLargeError)) throw error;
   return {kind: 'settlement', value: {outcome: {status: 'failed', error: {code: 'governance', retryable: false},
    diagnostic: {reason: 'request-too-large', phase: 'overview-synthesis', synthesisPhase:error.phase, preservedChildIds: input.childIds}}}};
  }
  const prepared = nodes.map(synthesis => ({synthesis, ...snapshotFor(synthesis)}));
  const manifest = MarketOverviewSynthesisRoundManifestSchema.parse({manifestVersion: 'overview-synthesis-round/v1', sourceReportAttemptId: input.sourceReportAttemptId,
   basisAttemptIds: input.basisAttemptIds, childIds: input.childIds, carriedChildIds,
   nodes: prepared.map(({synthesis, snapshot}) => ({nodeId: synthesis.nodeId, inputSnapshotId: snapshot.snapshotId, leafSectionIds: synthesis.leafSectionIds, dimensionId: synthesis.dimensionId, mode: synthesis.mode}))});
  signal.throwIfAborted();
  return {kind: 'settlement', value: {outcome: {status: 'succeeded', output: json(manifest)}, inputs: prepared.map(value => json(value.input)),
   children: prepared.map(value => marketOverviewSynthesisPreparation(value.snapshot.snapshotId, catalog.selectionRevision, catalog.dataCutoffAt))}};
 };
}
