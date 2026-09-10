import { z } from 'zod';
import { TrafficListingCollectionSchema, TrafficListingRecordSchema, type TrafficListingCollection, type TrafficListingRecord } from '../../shared/traffic-listing-contract';
import type { RemoteMcpConnector } from '../connectors/connector-contract';
import { canonicalJsonSha256 } from '../runtime/model-request-accounting';

const finiteScore = z.number().finite().nonnegative();
const ratio = finiteScore.max(1.000001);
const distribution = z.object({ score: finiteScore, ratio });
const Overview = z.object({ total: finiteScore, overview: z.object({ nf: distribution, ad: distribution.optional() }), ad: z.record(z.string(), distribution.extend({ name: z.string().optional() })), recommend: z.record(z.string(), distribution.extend({ name: z.string().min(1) })), data_notice: z.string().optional() });
const series = z.array(z.object({ score: finiteScore }));
const Structure = z.object({ chars: z.object({ dims: z.array(z.object({ val: z.string(), features: z.array(z.string()), img: z.string(), sumScore: finiteScore, ratio })), nfs: series, sps: series, recs: series, sbs: series, sbvs: series }) });
const channels = [['sp', 'SP(常规)'], ['recommend', 'SP(推荐)'], ['sb', 'SB(常规)'], ['sbv', 'SBV']] as const;
const percent = (value: number) => Math.min(100, Math.round(value * 1000) / 10);

export function normalizeListingDetails(rawOverview: unknown, rawStructure: unknown): TrafficListingRecord {
  const overview = Overview.parse(rawOverview);
  const { chars } = Structure.parse(rawStructure);
  const ad = overview.overview.ad ?? (Object.keys(overview.ad).length === 0 && overview.overview.nf.ratio === 1 && Math.abs(overview.total - overview.overview.nf.score) < 1e-8 ? { score: 0, ratio: 0 } : null);
  if (!ad) throw new Error('Incomplete SIF distribution');
  for (const key of ['nfs', 'sps', 'recs', 'sbs', 'sbvs'] as const) if (chars[key].length !== chars.dims.length) throw new Error('Incomplete SIF child channel series');
  const children = chars.dims.map((dim, index) => {
    const asin = dim.val.match(/(?:^|[^A-Z0-9])([A-Z0-9]{10})(?=$|[^A-Z0-9])/i)?.[1]?.toUpperCase();
    if (!asin) throw new Error('Invalid SIF child identifier');
    return { asin, label: dim.features.filter(Boolean).join(' / ') || '默认', image: /^https?:\/\//i.test(dim.img) ? dim.img : '', totalScore: Math.round(dim.sumScore), sharePct: percent(dim.ratio), organic: Math.round(chars.nfs[index].score), sp: Math.round(chars.sps[index].score), spRecommend: Math.round(chars.recs[index].score), sb: Math.round(chars.sbs[index].score), sbv: Math.round(chars.sbvs[index].score) };
  });
  if (new Set(children.map(child => child.asin)).size !== children.length) throw new Error('Duplicate SIF child identifier');
  const labels: Record<string,string> = Object.fromEntries(channels);
  return TrafficListingRecordSchema.parse({
    totalScore: Math.round(overview.total),
    naturalAd: [
      { label: '自然流量', score: Math.round(overview.overview.nf.score), ratio: percent(overview.overview.nf.ratio) },
      { label: '广告流量', score: Math.round(ad.score), ratio: percent(ad.ratio) },
    ],
    adChannels: Object.entries(overview.ad).filter(([,item]) => item.score > 0).map(([key,item]) => ({ label: labels[key] ?? (item.name?.trim() || key), score: Math.round(item.score), ratio: percent(item.ratio) })),
    recommendationSources: Object.values(overview.recommend).filter(item => item.score > 0 && item.ratio >= .01).sort((a,b) => b.score-a.score).slice(0,6).map(item => ({ label: item.name, score: Math.round(item.score), ratio: percent(item.ratio) })),
    children,
    updatedThrough: overview.data_notice?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
  });
}

export type ListingRequestEvidence = { asin: string; operation: string; fetchedAt: string; attemptCount: number; checksum: string };
export function listingContentId(value: unknown): string {
  const hash = canonicalJsonSha256(value);
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('SIF collection aborted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function collectTrafficListing(input: { connector: RemoteMcpConnector; organizationId: string; runId: string; asins: readonly string[]; marketplace: 'US'; id: string; signal?: AbortSignal }): Promise<{ collection: TrafficListingCollection; requests: ListingRequestEvidence[] }> {
  const records: Record<string, TrafficListingRecord> = {};
  const requests: ListingRequestEvidence[] = [];
  for (const asin of input.asins) {
    const values: unknown[] = [];
    for (const operation of ['ops_get_listing_traffic_overview', 'ops_get_listing_traffic_structure']) {
      input.signal?.throwIfAborted();
      const result = await withAbort(input.connector.execute({ operation, input: { asin, country: input.marketplace, timePieceType: 'latelyDay', timePieceValue: '30', ...(operation.endsWith('overview') ? { isListingSearch: true } : { pageSize: 1000 }) }, governorScope: { organizationId: input.organizationId, jobId: input.runId }, signal: input.signal }), input.signal);
      input.signal?.throwIfAborted();
      if (result.source.connectorId !== 'sif' || result.source.operation !== operation) throw new Error('SIF response identity mismatch');
      requests.push({ asin, operation, fetchedAt: result.source.fetchedAt, attemptCount: result.source.attemptCount, checksum: canonicalJsonSha256(result.data) });
      values.push(result.data);
    }
    records[asin] = normalizeListingDetails(values[0], values[1]);
  }
  input.signal?.throwIfAborted();
  return { collection: TrafficListingCollectionSchema.parse({ id: input.id, schemaVersion: '1', source: 'sif', marketplace: input.marketplace, period: '近30天', collectedAt: requests.map(item => item.fetchedAt).sort().at(-1), asins: [...input.asins], records }), requests };
}
