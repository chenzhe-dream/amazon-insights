import { z } from 'zod';
import { type MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION, MarketSourceIdentityValueSchemas, type MarketSourceEvidence } from '../../../shared/market-source-contracts';
import { collectMarketProductPool } from '../../services/market-product-pool-collector';
import { createMarketInputSnapshot } from './snapshot';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
export type MarketProductMonthObservation = {
    month: string;
    snapshot: MarketInputSnapshot;
    sourceRef: string;
};
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const same = (a: unknown, b: unknown) => { if (digest(a) !== digest(b))
    throw new TypeError('Product month evidence differs from its frozen source'); };
const supportedCoverageReasons = new Set([
    '接口返回头部样本，未证明全类目覆盖',
    '固定成员查询不代表全类目覆盖；缺失成员的当月数据未知',
    '接口返回样本按来源顺序截取到请求数量，未证明全类目覆盖',
    '来源返回量与固定成员命中数分别记录；额外商品不纳入样本，缺失成员的当月数据未知',
]);
/** Reuses the collector's normalizer against stored JSON only. The connector
 * below is an in-memory replay; this function never makes a network request. */
export async function readMarketProductMonth(observation: MarketProductMonthObservation, sources: Readonly<Record<string, MarketSourceEvidence>>) {
    const s = observation.snapshot;
    z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).parse(observation.month);
    same(s, createMarketInputSnapshot({ scope: s.scope, kind: s.kind, sourceVersion: s.sourceVersion, ruleVersion: s.ruleVersion, collectedAt: s.collectedAt, expectedRecordIds: s.expectedRecordIds, records: s.records }));
    if (s.kind !== 'products' || s.sourceVersion !== MARKET_SOURCE_HANDLER_VERSION || s.ruleVersion !== 'source-normalization/v1' || observation.month < s.scope.fromMonth || observation.month > s.scope.toMonth)
        throw new TypeError('Unsupported product month snapshot');
    const source = Object.hasOwn(sources, observation.sourceRef) ? sources[observation.sourceRef] : undefined;
    if (!source || observation.sourceRef !== 'market-source:' + digest(source) || source.provider !== 'sellerSprite' || source.operation !== 'market_product_concentration' || source.requestIdentity.month !== observation.month)
        throw new TypeError('Product source is unavailable');
    same(source.scope, s.scope);
    if (source.fetchedAt !== s.collectedAt)
        throw new TypeError('Product collection cutoff differs');
    // A provider response can be larger than either a head pool or a fixed pool.
    // Frozen snapshot membership, not raw coverage count, determines replay selection.
    const selected = s.expectedRecordIds.length ? [...s.expectedRecordIds] : undefined;
    if (source.coverage.truncation.status !== 'unknown' || !supportedCoverageReasons.has(source.coverage.truncation.reason) ||
        (source.coverage.expectedCount !== null && source.coverage.expectedCount !== s.expectedRecordIds.length))
        throw new TypeError('Unsupported product source coverage');
    const result = await collectMarketProductPool({ scope: s.scope, month: observation.month, poolSize: selected?.length ?? 1, newProductMonths: 6, ...(selected ? { selectedAsins: selected } : {}), jobId: 'shape-source-replay', now: () => new Date(source.fetchedAt), connector: { id: 'sellerSprite', probe: async () => { throw Error('No probe in source replay'); }, execute: async () => ({ data: structuredClone(source.payload) as Record<string, unknown>, source: { connectorId: 'sellerSprite', operation: source.operation, fetchedAt: source.fetchedAt, attemptCount: 1 } }) } });
    if (result.status === 'failed' || !result.evidence)
        throw new TypeError('Stored product source is invalid');
    // Only documented collection descriptions and expected coverage differ between
    // legacy head sampling and fixed-member replay. All factual evidence is exact.
    same({ ...result.evidence, coverage: { ...result.evidence.coverage,
        expectedCount: source.coverage.expectedCount,
        truncation: { ...result.evidence.coverage.truncation, reason: source.coverage.truncation.reason } } }, source);
    const expected = selected ?? result.products.map(p => p.asin);
    same([...expected].sort(), [...s.expectedRecordIds].sort());
    const records = result.products.map(product => ({ id: product.asin, scope: s.scope, data: { collection: 'product-month', month: observation.month, product, sourceRef: observation.sourceRef } })).sort((a, b) => a.id.localeCompare(b.id));
    same(records, s.records);
    const envelope = obj(source.payload), rawRows = envelope.data as unknown[];
    const products = result.products.map(product => {
        const raw = obj(rawRows[product.sourceIndex]);
        const confirmed = (field: keyof typeof MarketSourceIdentityValueSchemas, names: string[], expected: string) => [envelope, raw].some(row => names.some(name => { const p = MarketSourceIdentityValueSchemas[field].safeParse(row[name]); return p.success && p.data === expected; }));
        const scopeConfirmed = confirmed('marketplace', ['marketplace', 'site', 'amz_site'], s.scope.marketplace) && (confirmed('nodeIdPath', ['nodeIdPath', 'node_id_path'], s.scope.nodeIdPath) || confirmed('nodeId', ['nodeId', 'node_id'], s.scope.nodeIdPath.split(':').at(-1)!));
        return { ...product, scopeConfirmed, periodConfirmed: confirmed('month', ['month'], observation.month), currencyConfirmed: confirmed('currency', ['currency'], s.scope.currency) };
    });
    return { observation, source, products };
}
