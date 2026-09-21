import type {MarketOverviewSynthesisChild} from '../../../shared/market-overview-reduction-contracts';
import type {MarketOverviewSynthesisBasis} from '../../../shared/market-overview-synthesis-contracts';
import type {MarketShapeSynthesisChild} from '../../../shared/market-shape-synthesis-contracts';
import type {MarketShapeExplanationCatalog} from '../../../shared/market-shape-explanation-contracts';
import {validateMarketShapeExplanationCatalog} from './shape-explanation-catalog';
import { z } from 'zod';
import type { MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import type { MarketSourceEvidence } from '../../../shared/market-source-contracts';
import { MarketSemanticRecordSchema, MarketSemanticTaskNameSchema, type MarketSemanticInput, type MarketSemanticRecord,
  type MarketSemanticTaskName, type MarketSemanticValidationBinding } from '../../../shared/market-semantic-contracts';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { marketSemanticContracts } from '../../skills/market-semantic-task-definitions';
import { createMarketInputSnapshot } from './snapshot';
import { validateMarketSemanticInput } from './semantic-validation';

export const MARKET_SEMANTIC_BATCH_PLANNER_VERSION = 'market-semantic-batches/v1';
export const MARKET_SHAPE_SUGGESTION_BATCH_POLICY = Object.freeze({
  plannerVersion: 'market-semantic-batches/shape-single-product-v2', maxMembers: 1,
} as const);
const memberCaps = { 'market-overview-synthesis':1, 'market-shape-synthesis':1, 'market-shape-structure-explanation':1, 'market-overview-explanation': 1, 'market-product-shape-suggestion': MARKET_SHAPE_SUGGESTION_BATCH_POLICY.maxMembers,
  'market-keyword-semantics': 20, 'market-customer-theme-mapping': 12 } as const;
const kinds = { 'market-overview-synthesis':'overview', 'market-shape-synthesis':'overview', 'market-shape-structure-explanation':'overview', 'market-overview-explanation': 'overview', 'market-product-shape-suggestion': 'products',
  'market-keyword-semantics': 'keywords', 'market-customer-theme-mapping': 'customer-themes' } as const;
export interface MarketSemanticBatchPlanInput {
  overviewSynthesisBasis?:MarketOverviewSynthesisBasis;
  overviewSynthesisChildren?:readonly MarketOverviewSynthesisChild[];
  overviewSynthesisExpectedLeaves?:readonly string[];
  shapeExplanationCatalog?:MarketShapeExplanationCatalog;
  shapeSynthesisChildren?:readonly MarketShapeSynthesisChild[];
  shapeSynthesisExpectedLeaves?:readonly string[];
  task: MarketSemanticTaskName; moduleRunId: string; snapshot: MarketInputSnapshot; sources: Readonly<Record<string, MarketSourceEvidence>>;
  selectionRevision: string; configurationVersion: string; dataCutoffAt: string;
}
export interface MarketPreparedSemanticBatch {
  bindingId: string; memberRefs: string[]; input: MarketSemanticInput; validationBinding: MarketSemanticValidationBinding;
}
export interface MarketSemanticBatchPlan {
  plannerVersion: typeof MARKET_SEMANTIC_BATCH_PLANNER_VERSION | typeof MARKET_SHAPE_SUGGESTION_BATCH_POLICY.plannerVersion; basisHash: string;
  expectedMemberIds: string[]; missingMemberIds: string[];
  rejectedMembers: { memberId: string; reason: 'request-too-large' | 'missing-source' }[];
  batches: MarketPreparedSemanticBatch[];
}
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
/** Content-derived UUID-format IDs are persisted as native batch/binding records;
 * they are not legacy run IDs and do not confer execution authority. */
function stableId(value: unknown): string {
  const h = digest(value).slice(0, 32).split(''); h[12] = '4'; h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  const s = h.join(''); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
function catalog(record: MarketSemanticRecord): Record<string, unknown> {
  if (record.task === 'market-overview-explanation'||record.task === 'market-shape-structure-explanation'||(record.task==='market-shape-synthesis'||record.task==='market-overview-synthesis')) return {};
  if (record.task === 'market-product-shape-suggestion') { const { product: _product, ...rest } = record; return rest; }
  if (record.task === 'market-keyword-semantics') { const { keyword: _keyword, ...rest } = record; return rest; }
  const { theme: _theme, ...rest } = record; return rest;
}
export function marketSemanticRecordSourceRefs(record: MarketSemanticRecord): string[] {
  const refs: string[] = [];
  if (record.task === 'market-shape-structure-explanation'||(record.task==='market-shape-synthesis'||record.task==='market-overview-synthesis')) refs.push(...record.sourceRefs);
  else if (record.task === 'market-overview-explanation') refs.push(...[...record.metrics, ...record.gaps, ...record.facts].flatMap(x => x.sourceRefs));
  else if (record.task === 'market-keyword-semantics') refs.push(record.keyword.text.sourceRef);
  else if (record.task === 'market-product-shape-suggestion') {
    if (record.product.title.state === 'known') refs.push(record.product.title.value.sourceRef);
    if (record.product.parameters.state === 'known') refs.push(...record.product.parameters.value.map(x => x.sourceRef));
  } else {
    if (record.theme.keyword.state === 'known') refs.push(record.theme.keyword.value.sourceRef);
    if (record.theme.content.state === 'known') refs.push(record.theme.content.value.sourceRef);
  }
  return [...new Set(refs)].sort();
}

/** No network or database mutation. The meter must prepare the actual registered
 * skill request; false means input-size rejection, while infrastructure errors throw. */
export async function planMarketSemanticBatches(raw: MarketSemanticBatchPlanInput,
  fits: (input: MarketSemanticInput) => Promise<boolean>, signal?: AbortSignal): Promise<MarketSemanticBatchPlan> {
  signal?.throwIfAborted();
  const task = MarketSemanticTaskNameSchema.parse(raw.task);
  const plannerVersion = task === 'market-product-shape-suggestion'
    ? MARKET_SHAPE_SUGGESTION_BATCH_POLICY.plannerVersion : MARKET_SEMANTIC_BATCH_PLANNER_VERSION;
  z.string().uuid().parse(raw.moduleRunId);
  z.string().min(1).max(160).parse(raw.selectionRevision); z.string().min(1).max(240).parse(raw.configurationVersion);
  z.string().datetime().parse(raw.dataCutoffAt);
  const { moduleRunId, selectionRevision, configurationVersion, dataCutoffAt } = raw;
  const original = raw.snapshot;
  const snapshot = createMarketInputSnapshot({ scope: original.scope, kind: original.kind, sourceVersion: original.sourceVersion,
    ruleVersion: original.ruleVersion, collectedAt: original.collectedAt, expectedRecordIds: original.expectedRecordIds, records: original.records });
  if (digest(snapshot) !== digest(original) || snapshot.kind !== kinds[task] || Date.parse(raw.dataCutoffAt) < Date.parse(snapshot.collectedAt) || Date.parse(raw.dataCutoffAt) > Date.now()) throw new TypeError('Market batch snapshot or cutoff is invalid');
  const records = snapshot.records.map(r => ({ id: r.id, semantic: MarketSemanticRecordSchema.parse((r.data as { semantic?: unknown })?.semantic) }));
  if (records.some(r => r.semantic.task !== task) || (task === 'market-overview-explanation' && records.length > 1)) throw new TypeError('Market batch task does not match its records');
  if (records.some(r => digest(catalog(r.semantic)) !== digest(catalog(records[0].semantic)))) throw new TypeError('Market batch catalogs are inconsistent');
  const sourceRefs = [...new Set(records.flatMap(r => marketSemanticRecordSourceRefs(r.semantic)))].sort();
  const sources: Record<string, MarketSourceEvidence> = {};
  for (const ref of sourceRefs) {
    const source = Object.hasOwn(raw.sources, ref) ? raw.sources[ref] : undefined;
    if (!source || ref !== `market-source:${digest(source)}`) throw new TypeError('Market batch source is unavailable');
    sources[ref] = JSON.parse(JSON.stringify(source)) as MarketSourceEvidence;
  }
  freeze(sources);
  const shapeExplanationCatalog=(task==='market-shape-structure-explanation'||task==='market-shape-synthesis')?validateMarketShapeExplanationCatalog(raw.shapeExplanationCatalog as MarketShapeExplanationCatalog):undefined;
  const sourceCatalog = freeze(Object.fromEntries(records.map(r => [r.id, r.semantic])));
  const basisHash = digest({ planner: plannerVersion, task, moduleRunId, snapshotId: snapshot.snapshotId,
    selectionRevision, configurationVersion, dataCutoffAt });
  function batch(members: typeof records, verifySources = false): MarketPreparedSemanticBatch {
    const memberRefs = members.map(r => r.id), identity = { basisHash, memberRefs };
    const batchKey = `market-batch:${digest(identity)}`;
    const { organizationId: _organizationId, ...scope } = snapshot.scope;
    const first = members[0].semantic;
    let fields: Record<string, unknown>;
    if(first.task==='market-shape-synthesis'||first.task==='market-overview-synthesis')fields={synthesis:first.synthesis};
    else if(first.task==='market-shape-structure-explanation') fields={window:first.window};
    else if (first.task === 'market-overview-explanation') { const { task: _task, ...rest } = first; fields = rest; }
    else {
      const { task: _task, ...shared } = catalog(first);
      if (first.task === 'market-product-shape-suggestion') fields = { ...shared, products: members.map(r => (r.semantic as Extract<MarketSemanticRecord, { task: typeof first.task }>).product) };
      else if (first.task === 'market-keyword-semantics') fields = { ...shared, keywords: members.map(r => (r.semantic as Extract<MarketSemanticRecord, { task: typeof first.task }>).keyword) };
      else fields = { ...shared, themes: members.map(r => (r.semantic as Extract<MarketSemanticRecord, { task: typeof first.task }>).theme) };
    }
    const projection = { schemaVersion: '1.0.0', task, batchId: stableId({ ...identity, role: 'batch' }), scopeDigest: digest(snapshot.scope), scope,
      contentSnapshotId: snapshot.snapshotId, selectionRevision, batchKey, dataCutoffAt,
      sourceRefs: [...new Set(members.flatMap(r => marketSemanticRecordSourceRefs(r.semantic)))].sort(), ...fields };
    const inputDigest = digest(projection);
    const validationBinding = { scope: snapshot.scope, inputSnapshot: snapshot, sourceEvidenceByRef: sources,
      selectionRevision, batchKey, inputDigest, expectedIds: memberRefs, sourceCatalog, ...(task==='market-overview-synthesis'?{overviewSynthesisBasis:raw.overviewSynthesisBasis,overviewSynthesisChildren:raw.overviewSynthesisChildren,overviewSynthesisExpectedLeaves:raw.overviewSynthesisExpectedLeaves}:{}), ...(shapeExplanationCatalog?{shapeExplanationCatalog}:{}),...(task==='market-shape-synthesis'?{shapeSynthesisChildren:raw.shapeSynthesisChildren,shapeSynthesisExpectedLeaves:raw.shapeSynthesisExpectedLeaves}:{}) };
    const input = verifySources ? validateMarketSemanticInput({ ...projection, inputDigest }, validationBinding)
      : marketSemanticContracts[task].input.parse({ ...projection, inputDigest });
    return freeze({ bindingId: stableId({ ...identity, role: 'binding' }), memberRefs, input, validationBinding });
  }
  // Validate every available member in bounded groups before sizing. Candidate
  // resizing only changes the partition of these validated immutable records;
  // it must not repeatedly rebuild the entire snapshot once per added member.
  for (let i = 0; i < records.length; i += memberCaps[task]) { signal?.throwIfAborted(); batch(records.slice(i, i + memberCaps[task]), true); }
  const plan: MarketSemanticBatchPlan = { plannerVersion, basisHash,
    expectedMemberIds: [...snapshot.expectedRecordIds], missingMemberIds: snapshot.expectedRecordIds.filter(id => !Object.hasOwn(sourceCatalog, id)), rejectedMembers: [], batches: [] };
  let current: typeof records = [], accepted: MarketPreparedSemanticBatch | undefined;
  for (const record of records) {
    signal?.throwIfAborted();
    if (!marketSemanticRecordSourceRefs(record.semantic).length) { plan.rejectedMembers.push({ memberId: record.id, reason: 'missing-source' }); continue; }
    if (current.length === memberCaps[task]) { plan.batches.push(accepted!); current = []; accepted = undefined; }
    let candidate = batch([...current, record]);
    if (await fits(candidate.input)) { current.push(record); accepted = candidate; continue; }
    if (current.length) { plan.batches.push(accepted!); current = []; accepted = undefined; candidate = batch([record]);
      if (await fits(candidate.input)) { current = [record]; accepted = candidate; continue; } }
    plan.rejectedMembers.push({ memberId: record.id, reason: 'request-too-large' });
  }
  signal?.throwIfAborted(); if (accepted) plan.batches.push(accepted);
  return freeze(plan);
}
