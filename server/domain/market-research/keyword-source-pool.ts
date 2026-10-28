import { z } from 'zod';
import { MarketAnalysisScopeSchema, MarketInputRecordSchema, type MarketAnalysisScope, type MarketInputSnapshot, type MarketJsonValue } from '../../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION, type MarketSourceEvidence } from '../../../shared/market-source-contracts';
import { MarketKeywordSemanticsInputSchema } from '../../../shared/market-semantic-contracts';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { createMarketSourceEvidence } from './source-evidence';
import { createMarketInputSnapshot } from './snapshot';
import { projectMarketSourceSnapshot } from './source-semantic-projection';
import { normalizeMarketKeywordPageMembers } from './keyword-source-normalization';
import {MarketKeywordPageIdentitySchema} from '../../../shared/market-keyword-source-contracts';
export {MarketKeywordPageIdentitySchema} from '../../../shared/market-keyword-source-contracts';

export const MARKET_KEYWORD_POOL_VERSION = 'market-keyword-pool/v1';
type PageIdentity=z.infer<typeof MarketKeywordPageIdentitySchema>;
export const MarketKeywordPoolCatalogSchema = MarketKeywordSemanticsInputSchema.pick({ task: true, dictionaryVersion: true, categoryContext: true, dimensionLabels: true, clusterCatalog: true, discoveryMode:true, outputProtocol:true });
export type MarketKeywordPoolPage = { snapshot: MarketInputSnapshot; sourceRef: string };
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const same = (a: unknown, b: unknown) => { if (digest(a) !== digest(b)) throw new TypeError('Keyword pool source binding differs'); };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const json = (value: unknown) => MarketInputRecordSchema.shape.data.parse(value) as MarketJsonValue;
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

/** Fixed planned pages only. Deduplication chooses the first occurrence ordered
 * by seed, page, original source row. It never sums repeated queries or averages
 * their metrics; differing observations remain explicitly traceable. */
export function assembleMarketKeywordPool(options: { scope: MarketAnalysisScope; catalog: unknown; dataCutoffAt: string;
  plannedPages: readonly PageIdentity[]; maxMembers: number; pages: readonly MarketKeywordPoolPage[];
  sources: Readonly<Record<string, MarketSourceEvidence>> }) {
  const scope = MarketAnalysisScopeSchema.parse(options.scope), catalog = MarketKeywordPoolCatalogSchema.parse(options.catalog);
  const dataCutoffAt = z.string().datetime().parse(options.dataCutoffAt), maxMembers = z.number().int().min(1).max(2000).parse(options.maxMembers);
  if (Date.parse(dataCutoffAt) > Date.now()) throw new TypeError('Pool cutoff cannot be in the future');
  const plannedPages = z.array(MarketKeywordPageIdentitySchema).min(1).max(100).parse(options.plannedPages)
    .sort((a, b) => compare(a.seed, b.seed) || a.page - b.page);
  const key = (query: PageIdentity) => JSON.stringify([query.seed, query.page,query.sourceMode??'seed-extensions']);
  const planned = new Set(plannedPages.map(key)); if (planned.size !== plannedPages.length) throw new TypeError('Duplicate planned page');
  if (options.pages.length > plannedPages.length) throw new TypeError('Too many page inputs');
  const received = new Map<string, { snapshot: MarketInputSnapshot; sourceRef: string; source: MarketSourceEvidence; receivedCount: number;
    semantic: ReturnType<typeof projectMarketSourceSnapshot>['snapshot']; query: PageIdentity }>();
  for (const page of options.pages) {
    const source = Object.hasOwn(options.sources, page.sourceRef) ? options.sources[page.sourceRef] : undefined;
    if (!source || page.sourceRef !== `market-source:${digest(source)}`) throw new TypeError('Page evidence is unavailable');
    same(source.scope, scope);
    if (source.provider !== 'sorftime' || !['keyword_extends','category_keywords'].includes(source.operation)) throw new TypeError('Wrong keyword operation');
    const paths = Object.fromEntries(Object.entries(source.responseIdentity).filter(([, c]) => c.echoes.length + c.missingPaths.length > 0)
      .map(([field, c]) => [field, [...c.echoes.map(e => e.path), ...c.missingPaths]]));
    same(createMarketSourceEvidence({ scope, provider: source.provider, operation: source.operation, requestIdentity: source.requestIdentity, responseIdentityPaths: paths,
      payload: source.payload, fetchedAt: source.fetchedAt, observationPeriod: source.observationPeriod, units: source.units, coverage: source.coverage }), source);
    let query:PageIdentity;
    if(source.operation==='category_keywords'){
      same(source.requestIdentity.nodeId,scope.nodeIdPath.split(':').at(-1));same(source.requestIdentity.nodeIdPath,scope.nodeIdPath);
      const matches=plannedPages.filter(p=>p.sourceMode==='category-keywords'&&p.page===source.requestIdentity.page);
      if(matches.length!==1)throw new TypeError('Unplanned or duplicate page response');
      query=matches[0];
    }else query=MarketKeywordPageIdentitySchema.parse({seed:source.requestIdentity.keyword,page:source.requestIdentity.page});
    if (!planned.has(key(query)) || received.has(key(query))) throw new TypeError('Unplanned or duplicate page response');
    same(page.snapshot.scope, scope);
    if (Date.parse(page.snapshot.collectedAt) > Date.parse(dataCutoffAt)) throw new TypeError('Page is newer than pool cutoff');
    if (page.snapshot.records.some(r => obj(r.data).sourceRef !== page.sourceRef)) throw new TypeError('Page receipt differs from record source');
    const rawRows = obj(source.payload).data;
    if (!Array.isArray(rawRows) || rawRows.length > 20 || rawRows.length !== page.snapshot.records.length || page.snapshot.coverage.missingRecordIds.length) throw new TypeError('Incomplete or invalid page partition');
    const normalized = normalizeMarketKeywordPageMembers(scope, rawRows as MarketJsonValue[],source.operation as 'keyword_extends'|'category_keywords');
    if (normalized.issues.some(i => i.code === 'invalid' || i.code === 'duplicate-member')) throw new TypeError('Invalid raw keyword page');
    for (const member of normalized.members) same(member, obj(page.snapshot.records.find(r => r.id === member.id)?.data).member);
    // Also validates the immutable input hash, collector version and every source text/member.
    const semantic = projectMarketSourceSnapshot({ snapshot: page.snapshot, sources: options.sources, catalog }).snapshot;
    received.set(key(query), { ...page, source, receivedCount: rawRows.length, semantic, query });
  }
  type Occurrence = PageIdentity & { inputSnapshotId: string; sourceRef: string; sourceIndex: number; memberHash: string };
  const members = new Map<string, { raw: MarketInputSnapshot['records'][number]; semantic: MarketInputSnapshot['records'][number]; occurrences: Occurrence[]; metricHashes: Set<string> }>();
  const missingPages: typeof plannedPages = [], emptyPages: typeof plannedPages = [], fullPages: typeof plannedPages = [];
  for (const query of plannedPages) {
    const page = received.get(key(query)); if (!page) { missingPages.push(query); continue; }
    if (!page.receivedCount) emptyPages.push(query); if (page.receivedCount === 20) fullPages.push(query);
    const rawRows = obj(page.source.payload).data as unknown[];
    const rows = page.snapshot.records.map(raw => ({ raw, sourceIndex: rawRows.findIndex(row => obj(row).keyword === obj(obj(raw.data).member).rawKeyword) }))
      .sort((a, b) => a.sourceIndex - b.sourceIndex);
    for (const { raw, sourceIndex } of rows) {
      if (sourceIndex < 0) throw new TypeError('Keyword occurrence is unavailable');
      const member = obj(obj(raw.data).member), { id: _id, keyword: _keyword, rawKeyword: _raw, ...metrics } = member;
      const occurrence = { inputSnapshotId: page.snapshot.snapshotId, sourceRef: page.sourceRef, ...query, sourceIndex, memberHash: digest(member) };
      const existing = members.get(raw.id);
      if (existing) { existing.occurrences.push(occurrence); existing.metricHashes.add(digest(metrics)); }
      else members.set(raw.id, { raw, semantic: page.semantic.records.find(r => r.id === raw.id)!, occurrences: [occurrence], metricHashes: new Set([digest(metrics)]) });
    }
  }
  const ordered = [...members], selected = ordered.slice(0, maxMembers), omitted = ordered.slice(maxMembers).map(([id]) => id);
  const pageBindings = plannedPages.map(query => { const p = received.get(key(query)); return { ...query, inputSnapshotId: p?.snapshot.snapshotId ?? null, sourceRef: p?.sourceRef ?? null }; });
  const basisHash = digest({ version: MARKET_KEYWORD_POOL_VERSION, scope, catalog, dataCutoffAt, maxMembers, pageBindings });
  const common = { scope, kind: 'keywords' as const, sourceVersion: MARKET_SOURCE_HANDLER_VERSION, collectedAt: dataCutoffAt, expectedRecordIds: selected.map(([id]) => id) };
  const rawSnapshot = createMarketInputSnapshot({ ...common, ruleVersion: `${MARKET_KEYWORD_POOL_VERSION}:${basisHash}`,
    records: selected.map(([id, m]) => ({ id, scope, data: json({ ...obj(m.raw.data), occurrences: m.occurrences }) })) });
  const semanticSnapshot = createMarketInputSnapshot({ ...common, ruleVersion: `keyword-pool-semantic/v1:${basisHash}`,
    records: selected.map(([id, m]) => ({ id, scope, data: json({ ...obj(m.semantic.data), rawPoolSnapshotId: rawSnapshot.snapshotId, occurrences: m.occurrences }) })) });
  const manifest = { poolVersion: MARKET_KEYWORD_POOL_VERSION, basisHash, scope, catalogHash: digest(catalog), dataCutoffAt,
    rawInputSnapshotId: rawSnapshot.snapshotId, semanticInputSnapshotId: semanticSnapshot.snapshotId, pageBindings,
    sourceRefs: [...new Set([...received.values()].map(p => p.sourceRef))].sort(), plannedPageCount: plannedPages.length, receivedPageCount: received.size,
    missingPages, emptyPages, fullPages, collectionCoverage: received.size === 0 ? 'none' : missingPages.length ? 'partial' : 'complete',
    exhaustive: false as const, selectionPolicy: 'seed-page-source-order/first-observation/v1', maxMembers,
    uniqueObservedMemberCount: members.size, selectedMemberIds: selected.map(([id]) => id), selectedKeywords: selected.map(([, m]) => String(obj(obj(m.raw.data).member).keyword)),
    omittedMemberIds: omitted, memberLimitReached: omitted.length > 0, duplicateMemberCount: ordered.filter(([, m]) => m.occurrences.length > 1).length,
    conflictingMemberIds: ordered.filter(([, m]) => m.metricHashes.size > 1).map(([id]) => id).sort(),
    currencyAndPeriods: 'retain-per-source; no cross-page metric averaging' };
  return freeze({ rawSnapshot, semanticSnapshot, manifest });
}
