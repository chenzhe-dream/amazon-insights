import { z } from 'zod';
import { MarketInputRecordSchema, type MarketInputSnapshot, type MarketJsonValue, type MarketAnalysisScope } from '../../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION, MarketSourceIdentityValueSchemas, type MarketSourceEvidence } from '../../../shared/market-source-contracts';
import { MarketCustomerThemeMappingInputSchema } from '../../../shared/market-semantic-contracts';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { createMarketInputSnapshot } from './snapshot';
import { createMarketSourceEvidence } from './source-evidence';
import { projectMarketSourceSnapshot } from './source-semantic-projection';
import { aggregateCustomerThemes, type CustomerThemesAsinInput } from './customer-themes';

export const MARKET_THEME_SELECTION_VERSION = 'market-theme-selection/v1';
export const MARKET_THEME_POOL_VERSION = 'market-theme-pool/v1';
export const MarketThemePoolCatalogSchema = MarketCustomerThemeMappingInputSchema.pick({ task: true, mappingVersion: true, groupCatalog: true });
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const same = (a: unknown, b: unknown) => { if (digest(a) !== digest(b)) throw new TypeError('Theme pool source identity differs'); };
const json = (v: unknown) => MarketInputRecordSchema.shape.data.parse(v) as MarketJsonValue;
function freeze<T>(v: T): T { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function verifyInput(s: MarketInputSnapshot) {
  same(createMarketInputSnapshot({ scope: s.scope, kind: s.kind, sourceVersion: s.sourceVersion, ruleVersion: s.ruleVersion, collectedAt: s.collectedAt,
    expectedRecordIds: s.expectedRecordIds, records: s.records }), s);
  if (s.sourceVersion !== MARKET_SOURCE_HANDLER_VERSION) throw new TypeError('Unsupported collection version');
}
function evidence(scope: MarketAnalysisScope, ref: unknown, sources: Readonly<Record<string, MarketSourceEvidence>>) {
  const id = z.string().regex(/^market-source:[a-f0-9]{64}$/).parse(ref), s = Object.hasOwn(sources, id) ? sources[id] : undefined;
  if (!s || id !== `market-source:${digest(s)}`) throw new TypeError('Theme pool source is unavailable');
  same(s.scope, scope);
  const paths = Object.fromEntries(Object.entries(s.responseIdentity).filter(([, c]) => c.echoes.length + c.missingPaths.length > 0)
    .map(([field, c]) => [field, [...c.echoes.map(e => e.path), ...c.missingPaths]]));
  same(createMarketSourceEvidence({ scope, provider: s.provider, operation: s.operation, requestIdentity: s.requestIdentity, responseIdentityPaths: paths,
    payload: s.payload, fetchedAt: s.fetchedAt, observationPeriod: s.observationPeriod, units: s.units, coverage: s.coverage }), s);
  return s;
}

/** Select from one anchor-month provider pool. Original row order is observable;
 * it is deliberately not represented as a verified BSR ranking. */
export function selectMarketThemeMembers(options: { snapshot: MarketInputSnapshot; sources: Readonly<Record<string, MarketSourceEvidence>>; count: number }) {
  const s = options.snapshot, count = z.number().int().min(1).max(20).parse(options.count); verifyInput(s);
  if (s.kind !== 'products' || s.ruleVersion !== 'source-normalization/v1') throw new TypeError('Selection requires an anchor product collection');
  const refs = new Set<string>(), indices = new Set<number>(), months = new Set<string>();
  const checkedSources = new Map<string, MarketSourceEvidence>();
  const rows = s.records.map(record => {
    const data = obj(record.data), product = obj(data.product), ref = z.string().parse(data.sourceRef);
    const source = checkedSources.get(ref) ?? evidence(s.scope, ref, options.sources); checkedSources.set(ref, source);
    if (data.collection !== 'product-month' || source.provider !== 'sellerSprite' || source.operation !== 'market_product_concentration') throw new TypeError('Invalid product collection');
    const index = z.number().int().min(0).parse(product.sourceIndex), rawRows = obj(source.payload).data;
    if (!Array.isArray(rawRows) || indices.has(index)) throw new TypeError('Invalid source row partition');
    same(MarketSourceIdentityValueSchemas.asin.parse(obj(rawRows[index]).asin), record.id); same(product.asin, record.id);
    same(data.month, source.requestIdentity.month); if (Date.parse(source.fetchedAt) > Date.parse(s.collectedAt)) throw new TypeError('Selection cutoff differs');
    refs.add(ref); indices.add(index); months.add(z.string().parse(data.month)); return { record, index };
  }).sort((a, b) => a.index - b.index);
  if (refs.size > 1 || months.size > 1) throw new TypeError('Selection must use one anchor source');
  const chosen = rows.slice(0, count), selectedAsins = chosen.map(r => r.record.id);
  const basisHash = digest({ version: MARKET_THEME_SELECTION_VERSION, sourceInputSnapshotId: s.snapshotId, count, selectionBasis: 'provider-row-order' });
  const snapshot = createMarketInputSnapshot({ scope: s.scope, kind: 'products', sourceVersion: MARKET_SOURCE_HANDLER_VERSION,
    ruleVersion: `${MARKET_THEME_SELECTION_VERSION}:${basisHash}`, collectedAt: s.collectedAt, expectedRecordIds: selectedAsins, records: chosen.map(r => r.record) });
  return freeze({ snapshot, manifest: { selectionVersion: MARKET_THEME_SELECTION_VERSION, basisHash, selectionInputSnapshotId: snapshot.snapshotId,
    sourceInputSnapshotId: s.snapshotId, requestedCount: count, selectedAsins, omittedAsins: rows.slice(count).map(r => r.record.id),
    sourceRefs: [...refs], anchorMonth: [...months][0] ?? null, selectionBasis: 'provider-row-order', bsrTopVerified: false as const,
    observedProductCount: rows.length, sourceMissingAsins: [...s.coverage.missingRecordIds], requestedCountMet: selectedAsins.length === count } });
}

export function assembleMarketThemePool(options: { selection: MarketInputSnapshot; selectedAsins: readonly string[]; catalog: unknown; dataCutoffAt: string;
  observations: readonly { snapshot: MarketInputSnapshot; sourceRef: string }[]; sources: Readonly<Record<string, MarketSourceEvidence>>;
  failures: readonly { asin: string; attemptId: string; code: string }[] }) {
  const selection = options.selection; verifyInput(selection);
  if (selection.kind !== 'products' || !selection.ruleVersion.startsWith(`${MARKET_THEME_SELECTION_VERSION}:`)) throw new TypeError('A fixed theme selection is required');
  const selectedAsins = z.array(z.string().regex(/^[A-Z0-9]{10}$/)).min(1).max(20).parse(options.selectedAsins);
  if (new Set(selectedAsins).size !== selectedAsins.length) throw new TypeError('Duplicate selected ASIN');
  same([...selectedAsins].sort(), [...selection.expectedRecordIds].sort());
  if (selection.coverage.status !== 'complete') throw new TypeError('Selected membership is incomplete');
  same(selectedAsins, [...selection.records].sort((a, b) => z.number().int().parse(obj(obj(a.data).product).sourceIndex) - z.number().int().parse(obj(obj(b.data).product).sourceIndex)).map(r => r.id));
  const catalog = MarketThemePoolCatalogSchema.parse(options.catalog), cutoff = z.string().datetime().parse(options.dataCutoffAt);
  if (Date.parse(cutoff) > Date.now() || Date.parse(selection.collectedAt) > Date.parse(cutoff)) throw new TypeError('Invalid theme pool cutoff');
  const seen = new Set<string>(), results: CustomerThemesAsinInput[] = [], semanticRows: MarketInputSnapshot['records'][number][] = [];
  const bindings: { asin: string; inputSnapshotId: string | null; sourceRef: string | null; failureAttemptId: string | null }[] = [];
  const payloadGroups = new Map<string, string[]>();
  for (const observation of options.observations) {
    const s = observation.snapshot; verifyInput(s); same(s.scope, selection.scope);
    if (s.kind !== 'customer-themes' || s.records.length !== 1 || s.expectedRecordIds.length !== 1 || Date.parse(s.collectedAt) > Date.parse(cutoff)) throw new TypeError('Invalid ASIN observation');
    const record = s.records[0], id = record.id;
    if (!selectedAsins.includes(id) || seen.has(id)) throw new TypeError('Outside or duplicate selected ASIN'); seen.add(id);
    same(obj(record.data).sourceRef, observation.sourceRef);
    const source = evidence(selection.scope, observation.sourceRef, options.sources);
    // Exact theme text, IDs and counts are verified before deterministic aggregation.
    const projection = projectMarketSourceSnapshot({ snapshot: s, sources: options.sources, catalog: { ...catalog, selectedAsins } });
    const result = obj(record.data).result as CustomerThemesAsinInput;
    same(result.source?.fetchedAt, source.fetchedAt); same(result.source?.sourceUpdatedAt, null);
    results.push(result); semanticRows.push(...projection.snapshot.records);
    bindings.push({ asin: id, inputSnapshotId: s.snapshotId, sourceRef: observation.sourceRef, failureAttemptId: null });
    if (result.status === 'success') { const group = payloadGroups.get(source.payloadHash) ?? []; group.push(id); payloadGroups.set(source.payloadHash, group); }
  }
  const failures = z.array(z.object({ asin: z.string().regex(/^[A-Z0-9]{10}$/), attemptId: z.string().uuid(), code: z.string().min(1).max(100) }).strict()).max(20).parse(options.failures);
  if (new Set(failures.map(f => f.attemptId)).size !== failures.length) throw new TypeError('Failure attempt cannot belong to multiple ASINs');
  for (const failure of failures) {
    if (!selectedAsins.includes(failure.asin) || seen.has(failure.asin)) throw new TypeError('Contradictory or outside failed ASIN'); seen.add(failure.asin);
    results.push({ asin: failure.asin, status: 'failed', source: null, reason: failure.code });
    bindings.push({ asin: failure.asin, inputSnapshotId: null, sourceRef: null, failureAttemptId: failure.attemptId });
  }
  bindings.sort((a, b) => selectedAsins.indexOf(a.asin) - selectedAsins.indexOf(b.asin));
  results.sort((a, b) => selectedAsins.indexOf(a.asin) - selectedAsins.indexOf(b.asin));
  const basisHash = digest({ version: MARKET_THEME_POOL_VERSION, selectionInputSnapshotId: selection.snapshotId, selectedAsins, catalog, cutoff, bindings,
    failures: [...failures].sort((a, b) => a.asin.localeCompare(b.asin)) });
  const rawSnapshot = createMarketInputSnapshot({ scope: selection.scope, kind: 'customer-themes', sourceVersion: MARKET_SOURCE_HANDLER_VERSION,
    ruleVersion: `${MARKET_THEME_POOL_VERSION}:${basisHash}`, collectedAt: cutoff, expectedRecordIds: selectedAsins,
    records: results.map(result => ({ id: result.asin, scope: selection.scope, data: json({ collection: 'customer-theme-pool', result, binding: bindings.find(b => b.asin === result.asin)! }) })) });
  const semanticSnapshot = createMarketInputSnapshot({ scope: selection.scope, kind: 'customer-themes', sourceVersion: MARKET_SOURCE_HANDLER_VERSION,
    ruleVersion: `theme-pool-semantic/v1:${basisHash}`, collectedAt: cutoff, expectedRecordIds: semanticRows.map(r => r.id),
    records: semanticRows.map(r => ({ ...r, data: json({ ...obj(r.data), rawPoolSnapshotId: rawSnapshot.snapshotId }) })) });
  const aggregation = aggregateCustomerThemes({ selectedAsins, results, mappings: [] });
  return freeze({ rawSnapshot, semanticSnapshot, aggregation, manifest: { poolVersion: MARKET_THEME_POOL_VERSION, basisHash, selectedAsins,
    selectionInputSnapshotId: selection.snapshotId, rawInputSnapshotId: rawSnapshot.snapshotId, semanticInputSnapshotId: semanticSnapshot.snapshotId, bindings,
    missingAsins: selectedAsins.filter(id => !seen.has(id)), coverage: aggregation.coverage, sourceRefs: bindings.flatMap(b => b.sourceRef ? [b.sourceRef] : []).sort(),
    reviewDeduplication: 'unavailable', metricKind: 'customers_say_topic_share', semanticStatus: semanticRows.length ? 'pending' : 'no-input',
    sharedPayloadGroups: [...payloadGroups].filter(([, ids]) => ids.length > 1).map(([payloadHash, asins]) => ({ payloadHash, asins: asins.sort() })).sort((a, b) => a.payloadHash.localeCompare(b.payloadHash)) } });
}
