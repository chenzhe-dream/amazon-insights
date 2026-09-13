import { z } from 'zod';
import { type MarketInputSnapshot, type MarketJsonValue, MarketInputRecordSchema } from '../../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION, MarketSourceIdentityValueSchemas, type MarketSourceEvidence } from '../../../shared/market-source-contracts';
import { MarketShapeSuggestionInputSchema, MarketKeywordSemanticsInputSchema, MarketCustomerThemeMappingInputSchema, MarketSemanticRecordSchema, type MarketSemanticRecord } from '../../../shared/market-semantic-contracts';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { createMarketInputSnapshot } from './snapshot';
import { createMarketSourceEvidence } from './source-evidence';
import { marketKeywordMemberId } from './keyword-source-normalization';

export const MARKET_SOURCE_PROJECTION_VERSION = 'market-source-semantic/v1';
export const MarketProjectionCatalogSchema = z.discriminatedUnion('task', [
  MarketShapeSuggestionInputSchema.pick({ task: true, taxonomyVersion: true, allowedLabels: true }),
  MarketKeywordSemanticsInputSchema.pick({ task: true, dictionaryVersion: true, categoryContext: true, dimensionLabels: true, clusterCatalog: true, discoveryMode:true, outputProtocol:true }),
  MarketCustomerThemeMappingInputSchema.pick({ task: true, mappingVersion: true, selectedAsins: true, groupCatalog: true }),
]);
export type MarketProjectionCatalog = z.infer<typeof MarketProjectionCatalogSchema>;
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const same = (a: unknown, b: unknown) => { if (digest(a) !== digest(b)) throw new TypeError('Source projection identity or field differs'); };
const array = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new TypeError('Source rows are unavailable'); return v; };
const json = (value: unknown) => MarketInputRecordSchema.shape.data.parse(value) as MarketJsonValue;

/** Deterministic, no network: project one immutable collector input. Complete-pool
 * assembly is a separate step. Text is never shortened or generated here. */
export function projectMarketSourceSnapshot(options: { snapshot: MarketInputSnapshot; sources: Readonly<Record<string, MarketSourceEvidence>>; catalog: unknown }) {
  const catalog = MarketProjectionCatalogSchema.parse(options.catalog), original = options.snapshot;
  const input = { scope: original.scope, kind: original.kind, sourceVersion: original.sourceVersion, ruleVersion: original.ruleVersion,
    collectedAt: original.collectedAt, expectedRecordIds: original.expectedRecordIds, records: original.records };
  const sourceSnapshot = createMarketInputSnapshot(input); same(sourceSnapshot, original);
  if (sourceSnapshot.sourceVersion !== MARKET_SOURCE_HANDLER_VERSION || sourceSnapshot.ruleVersion !== 'source-normalization/v1') throw new TypeError('Unsupported source projection version');
  const kind = catalog.task === 'market-product-shape-suggestion' ? 'products' : catalog.task === 'market-keyword-semantics' ? 'keywords' : 'customer-themes';
  if (sourceSnapshot.kind !== kind) throw new TypeError('Source collection does not match semantic task');
  const verified = new Map<string, MarketSourceEvidence>();
  function evidence(ref: unknown) {
    const id = z.string().regex(/^market-source:[a-f0-9]{64}$/).parse(ref);
    if (verified.has(id)) return { ref: id, source: verified.get(id)! };
    const source = Object.hasOwn(options.sources, id) ? options.sources[id] : undefined;
    if (!source || id !== `market-source:${digest(source)}`) throw new TypeError('Source evidence is unavailable');
    same(source.scope, sourceSnapshot.scope);
    const responseIdentityPaths = Object.fromEntries(Object.entries(source.responseIdentity).filter(([, c]) => c.echoes.length + c.missingPaths.length > 0)
      .map(([field, c]) => [field, [...c.echoes.map(e => e.path), ...c.missingPaths]]));
    same(createMarketSourceEvidence({ scope: source.scope, provider: source.provider, operation: source.operation, requestIdentity: source.requestIdentity,
      responseIdentityPaths, payload: source.payload, fetchedAt: source.fetchedAt, observationPeriod: source.observationPeriod, units: source.units, coverage: source.coverage }), source);
    if (Date.parse(source.fetchedAt) > Date.parse(sourceSnapshot.collectedAt)) throw new TypeError('Source is newer than its snapshot');
    verified.set(id, source); return { ref: id, source };
  }
  const rows: { id: string; scope: typeof sourceSnapshot.scope; data: MarketJsonValue }[] = [], emptyAsins: string[] = [];
  function append(id: string, semantic: unknown, sourceFields: unknown[], extra: Record<string, unknown> = {}) {
    const parsed = MarketSemanticRecordSchema.parse(semantic);
    rows.push({ id, scope: sourceSnapshot.scope, data: json({ semantic: parsed, sourceInputSnapshotId: sourceSnapshot.snapshotId, sourceFields, ...extra }) });
  }
  for (const record of sourceSnapshot.records) {
    const data = obj(record.data), { ref, source } = evidence(data.sourceRef), payload = obj(source.payload);
    const fields: { refId: string; sourceRef: string; path: (string | number)[] }[] = [];
    function field(owner: string, role: 'title' | 'keyword' | 'content', text: string, path: (string | number)[]) {
      const refId = `market-text:${digest({ ref, owner, role, path })}`;
      fields.push({ refId, sourceRef: ref, path }); return { refId, sourceRef: ref, recordId: owner, field: role, text };
    }
    if (catalog.task === 'market-product-shape-suggestion') {
      if (data.collection !== 'product-month' || source.provider !== 'sellerSprite' || source.operation !== 'market_product_concentration') throw new TypeError('Invalid product source');
      const product = obj(data.product), index = z.number().int().min(0).parse(product.sourceIndex);
      const row = obj(array(payload.data)[index]); same(MarketSourceIdentityValueSchemas.asin.parse(row.asin), record.id); same(product.asin, record.id);
      same(source.requestIdentity.month, data.month);
      const text = typeof row.title === 'string' && row.title.trim() ? row.title : null;
      same(product.title, text?.trim() ?? null);
      append(record.id, { ...catalog, product: { productId: record.id, asin: record.id,
        title: text === null ? { state: 'missing', reason: 'field-absent' } : { state: 'known', value: field(record.id, 'title', text, ['data', index, 'title']) },
        parameters: { state: 'missing', reason: 'not-collected' } } }, fields);
    } else if (catalog.task === 'market-keyword-semantics') {
      if (data.collection !== 'keyword-page' || source.provider !== 'sorftime' || source.operation !== 'keyword_extends') throw new TypeError('Invalid keyword source');
      const member = obj(data.member), raw = z.string().parse(member.rawKeyword), normalized = MarketSourceIdentityValueSchemas.keyword.parse(raw);
      same(member.keyword, normalized); same(member.id, record.id);
      const scope = sourceSnapshot.scope;
      same(record.id, marketKeywordMemberId(scope, normalized));
      const candidates = array(payload.data).map((row, index) => ({ row: obj(row), index })).filter(({ row }) => row.keyword === raw);
      if (candidates.length !== 1) throw new TypeError('Keyword raw member is ambiguous or absent');
      append(record.id, { ...catalog, keyword: { keywordId: record.id, text: field(record.id, 'keyword', raw, ['data', candidates[0].index, 'keyword']) } }, fields);
    } else {
      if (data.collection !== 'customer-themes' || source.provider !== 'sorftime' || source.operation !== 'product_customers_say') throw new TypeError('Invalid theme source');
      const result = obj(data.result); same(result.asin, record.id); same(source.requestIdentity.asin, record.id);
      if (!catalog.selectedAsins.includes(record.id)) throw new TypeError('Theme ASIN is outside the fixed selection');
      const sourceRecordId = `customers-say:${source.payloadHash}:${record.id}`;
      same(obj(result.source).sourceRecordId, sourceRecordId);
      if (result.status === 'empty') {
        const details = obj(payload.data).details;
        const emptyBlock = Array.isArray(payload.content) && payload.content.length === 1 ? obj(payload.content[0]) : {};
        const observedEmpty = !Object.hasOwn(payload, 'data') && !Object.hasOwn(payload, 'structuredContent') && payload.isError !== true &&
          emptyBlock.type === 'text' && typeof emptyBlock.text === 'string' && emptyBlock.text.trim() === 'No relevant data.';
        if (!(Array.isArray(details) && details.length === 0) && !observedEmpty) throw new TypeError('Empty theme receipt differs from source');
        emptyAsins.push(record.id); continue;
      }
      if (result.status !== 'success') throw new TypeError('Failed theme source cannot be projected');
      const themes = array(result.themes), rawThemes = array(obj(payload.data).details);
      if (!themes.length || themes.length !== rawThemes.length) throw new TypeError('Theme partition differs from source');
      themes.forEach((value, index) => {
        const theme = obj(value), raw = obj(rawThemes[index]), id = `${sourceRecordId}:${index}`;
        same(theme.sourceThemeId, id);
        for (const key of ['keyword', 'content', 'mention', 'positive', 'negative']) same(theme[key], raw[key]);
        same(theme.sourceUpdatedAt, raw.update_time);
        const keyword = z.string().min(1).parse(raw.keyword), content = z.string().parse(raw.content);
        const counts = z.object({ mention: z.number().int().nonnegative().safe(), positive: z.number().int().nonnegative().safe(), negative: z.number().int().nonnegative().safe() }).parse(raw);
        if (counts.positive > counts.mention || counts.negative > counts.mention) throw new TypeError('Invalid theme counts');
        const first = fields.length;
        const semantic: MarketSemanticRecord = { ...catalog, theme: { sourceThemeId: id, asin: record.id,
          keyword: { state: 'known', value: field(id, 'keyword', keyword, ['data', 'details', index, 'keyword']) },
          content: content.trim() ? { state: 'known', value: field(id, 'content', content, ['data', 'details', index, 'content']) } : { state: 'missing', reason: 'field-absent' } } };
        append(id, semantic, fields.slice(first), { sourceRef: ref, sourceRecordId, counts });
      });
    }
  }
  const catalogHash = digest(catalog);
  const snapshot = createMarketInputSnapshot({ scope: sourceSnapshot.scope, kind, sourceVersion: MARKET_SOURCE_HANDLER_VERSION,
    ruleVersion: `${MARKET_SOURCE_PROJECTION_VERSION}:${catalogHash}`, collectedAt: sourceSnapshot.collectedAt,
    expectedRecordIds: kind === 'customer-themes' ? rows.map(r => r.id) : sourceSnapshot.expectedRecordIds, records: rows });
  const manifest = { projectionVersion: MARKET_SOURCE_PROJECTION_VERSION, catalogHash, task: catalog.task,
    sourceKind: kind === 'customer-themes' ? 'customers-say' : kind === 'keywords' ? 'keyword-extensions' : 'product-month',
    sourceInputSnapshotId: sourceSnapshot.snapshotId, inputSnapshotId: snapshot.snapshotId, sourceRefs: [...verified.keys()].sort(),
    missingSourceMemberIds: [...sourceSnapshot.coverage.missingRecordIds], emptyAsins,
    unrepresentedSelectedAsins: catalog.task === 'market-customer-theme-mapping' ? catalog.selectedAsins.filter(id => !sourceSnapshot.expectedRecordIds.includes(id)) : [] };
  return { snapshot, manifest };
}
