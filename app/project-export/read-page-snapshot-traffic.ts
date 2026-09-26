import {ApiErrorResponseSchema, GetRunResponseSchema, LocalDataStageOutputResponseSchema, TrafficSnapshotReadResponseSchema, type TrafficSnapshotReadResponse} from '../../shared/agent-contracts';
import {TrafficListingDistributionSchema} from '../../shared/traffic-listing-contract';
import {MarketSiteSchema, type MarketSite} from '../../shared/market-sites';
import {mergeTrafficRecord} from '../lib/traffic-detail-view';
import type {TrafficDisplayData} from '../sif-listing-traffic-data';
import type {Product} from '../project-report-views/competitor-overview';
import type {ExportModuleContext, ExportModuleRead} from './export-module-context';

export type SnapshotTrafficSeries = {asin: string; points: {month: string; label: string; natural: number|null; ad: number|null; total: number|null}[]};
export type TrafficSnapshotSources = {products: Product[]; market: MarketSite; trafficData: TrafficDisplayData; monthlyTrendByAsin: Record<string, SnapshotTrafficSeries>};
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && [...a].sort().every((v,i)=>v === [...b].sort()[i]);
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])) : value; }
const signature = (value: unknown) => JSON.stringify(canonical(value));
function number(value: unknown): number|null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('流量数值格式无效');
  return value;
}
function scoped(value: unknown, asin: string, market: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('流量数据格式无效');
  const item = object(value);
  if ((item.asin !== undefined && item.asin !== asin) || (item.marketplace !== undefined && item.marketplace !== market)) throw Error('流量数据来源范围不匹配');
  return item;
}

/** Freeze only the original traffic page's inputs. No saved-history append or analysis request. */
export async function readPageSnapshotTraffic(context: ExportModuleContext, fetcher: ExportModuleRead, products: Product[]): Promise<TrafficSnapshotSources> {
  const market = MarketSiteSchema.parse(context.marketplace);
  if (!context.asins.length || new Set(context.asins).size !== context.asins.length || context.asins.some(asin=>!context.sourceAsins.includes(asin))
      || !same(products.map(p=>p.asin),context.asins)) throw Error('流量导出范围不匹配');
  const read: ExportModuleRead = (path,init) => fetcher(path,{...init,method:'GET',cache:'no-store'});
  const version = context.version;
  if (version) {
    if (version.organizationId !== context.organizationId || version.projectId !== context.projectId || version.marketplace !== market
        || context.asins.some(asin=>!version.asins.includes(asin)) || version.asins.some(asin=>!context.sourceAsins.includes(asin))) throw Error('流量发布版本范围不匹配');
    const stage = version.stageOutputs.traffic;
    if (stage && stage.stageStatus !== 'missing-output') {
      const parsed = LocalDataStageOutputResponseSchema.safeParse(stage);
      if (!parsed.success || parsed.data.stage !== 'traffic' || parsed.data.projectId !== version.projectId || parsed.data.runId !== version.runId || parsed.data.jobId !== version.jobId) throw Error('流量阶段归属范围不匹配');
    }
  }
  const runId = context.currentRunId;
  if (runId) {
    const response = await read(`/v1/runs/${encodeURIComponent(runId)}`);
    const parsed = GetRunResponseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success || parsed.data.run.id !== runId || parsed.data.run.projectId !== context.projectId) throw Error('流量运行批次归属范围不匹配');
  }
  async function readSnapshot(): Promise<TrafficSnapshotReadResponse|null> {
    if (version || !runId) return null;
    const response = await read(`/v1/runs/${encodeURIComponent(runId)}/traffic-snapshot`);
    const body: unknown = await response.json();
    if (response.status === 404) {
      const error = ApiErrorResponseSchema.safeParse(body);
      if (error.success && error.data.error.code === 'NOT_FOUND') return null;
    }
    if (!response.ok) throw Error(`流量快照读取失败（${response.status}）`);
    const parsed = TrafficSnapshotReadResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.marketplace !== market || !same(parsed.data.asins,context.sourceAsins)) throw Error('流量快照范围或格式不匹配');
    const returned = parsed.data.traffic.competitors.map(item=>item.asin);
    const collected = Object.keys(parsed.data.listingCollection?.records ?? {});
    if (new Set(returned).size !== returned.length || [...returned,...collected].some(asin=>!context.sourceAsins.includes(asin))) throw Error('流量快照商品范围不匹配');
    return parsed.data;
  }
  const snapshot = await readSnapshot();
  const stage = version?.stageOutputs.traffic;
  const data = stage && 'data' in stage ? object(stage.data) : {};
  const listings = version ? object(data.listingByAsin) : {};
  const months = version ? object(data.monthlyByAsin) : {};
  let updatedThrough: string|null = snapshot?.collectedAt.slice(0,10) ?? null;
  if (!version && snapshot) {
    for (const item of snapshot.traffic.competitors) if (context.asins.includes(item.asin)) {
      listings[item.asin] = {totalScore:item.trafficVolume,naturalAd:[{label:'自然流量',score:item.naturalVolume,ratio:item.naturalShare},{label:'广告流量',score:item.advertisingVolume,ratio:item.advertisingShare}],childCount:item.childCount,updatedThrough};
      months[item.asin] = {points:item.monthlyTrend};
    }
    for (const [asin,record] of Object.entries(snapshot.listingCollection?.records ?? {})) if (context.asins.includes(asin)) listings[asin] = record;
  }
  const overview: TrafficDisplayData['overview'] = {};
  const detailAvailability: NonNullable<TrafficDisplayData['detailAvailability']> = {};
  const monthlyTrendByAsin: Record<string,SnapshotTrafficSeries> = {};
  for (const asin of context.asins) {
    overview[asin] = null;
    if (listings[asin] !== undefined) {
      const source = scoped(listings[asin],asin,market);
      if (source.naturalAd !== undefined && !TrafficListingDistributionSchema.array().safeParse(source.naturalAd).success) throw Error('流量自然/广告明细格式无效');
      const merged = mergeTrafficRecord(source);
      if (Object.values(merged.availability).includes('invalid')) throw Error('流量结构明细格式无效');
      overview[asin] = merged.overview; detailAvailability[asin] = merged.availability;
      if (merged.overview?.updatedThrough && (!updatedThrough || merged.overview.updatedThrough > updatedThrough)) updatedThrough = merged.overview.updatedThrough;
    }
    if (months[asin] !== undefined) {
      const item = scoped(months[asin],asin,market);
      if (!Array.isArray(item.points)) throw Error('流量月份明细格式无效');
      const seen = new Set<string>();
      monthlyTrendByAsin[asin] = {asin,points:item.points.map(raw=>{
        const point=object(raw);
        if (typeof point.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(point.month) || seen.has(point.month)) throw Error('流量月份明细格式无效');
        seen.add(point.month);
        const natural=number(point.natural), ad=number(point.ad === undefined ? point.advertising : point.ad);
        const total=point.total === undefined ? natural !== null && ad !== null ? natural+ad : null : number(point.total);
        return {month:point.month,label:`${Number(point.month.slice(5,7))}月`,natural,ad,total};
      })};
    }
  }
  if (!version && runId && signature(snapshot) !== signature(await readSnapshot())) throw Error('流量快照在准备期间变化，请重新准备');
  return structuredClone({products,market,monthlyTrendByAsin,trafficData:{overview,monthlyTrend:{},detailAvailability,meta:{
    source:version ? '已有报告 · 流量阶段' : '当前运行 SIF 快照',period:version || snapshot?.listingCollection ? '近30天' : '当前运行快照',
    country:market,updatedThrough,status:'ready',emptyMessage:'暂无完整且可核验的流量结构明细',
  }}});
}
