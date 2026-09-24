import type { AnalysisReport, TrafficSnapshotReadResponse } from '../../shared/agent-contracts';
import { TrafficListingDistributionSchema } from '../../shared/traffic-listing-contract';
import { marketSites } from '../../shared/market-sites';
import { buildTrafficAnalysisConclusion } from '../traffic-analysis-conclusion';
import { mergeTrafficRecord, trafficDetailMessage, type TrafficDetailAvailability } from '../lib/traffic-detail-view';
import type { TrafficDisplayData, TrafficDisplayOverview } from '../sif-listing-traffic-data';
import type { ExportModuleContext } from './export-module-context';
import type { ExportBlock, ExportCell, ExportSection } from './export-contracts';
import { exportFields } from './export-record-blocks';

type RecordValue = Record<string, unknown>;
export type TrafficExportSources = { snapshot: TrafficSnapshotReadResponse | null; report: AnalysisReport | null };
const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const valueText = (value: unknown) => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const cell = (value: unknown): ExportCell => ({ text: valueText(value) });
function table(title: string, columns: string[], rows: unknown[][]): ExportBlock { return { kind: 'table', title, columns, rows: rows.map(row => row.map(cell)) }; }
function nonnegative(value: unknown) { if (value == null) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('流量数值格式无效'); return value; }
function scopedRecord(value: unknown, context: ExportModuleContext, asin: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('流量数据格式无效');
  const item = object(value);
  if ((item.asin !== undefined && item.asin !== asin) || (item.marketplace !== undefined && item.marketplace !== context.marketplace)) throw Error('流量数据范围不匹配');
  return item;
}

const reportLabels: Record<string, string> = {
  schemaVersion:'结果格式版本', kind:'结果类型', status:'结果状态', identity:'来源标识', dataCutoffAt:'数据截止时间', inputDigest:'输入内容摘要',
  summary:'报告摘要', competitors:'竞品指标', asin:'ASIN', brand:'品牌', trafficRank:'流量排名', trafficVolume:'总流量分',
  naturalVolume:'自然流量分', naturalShare:'自然流量占比（%）', advertisingVolume:'广告流量分', advertisingShare:'广告流量占比（%）',
  top1Share:'Top1 子体占比（%）', top3Share:'Top3 子体占比（%）', hhi:'子体集中度 HHI', effectiveChildren:'有效子体数', childCount:'子体总数',
  recommendationTraffic:'推荐流量分', maxAdvertisingChannel:'最大广告渠道', maxAdvertisingChannelShare:'最大广告渠道占比（%）', effectiveAdvertisingChannels:'有效广告渠道数',
  pullGrade:'拉量能力', naturalGrade:'自然沉淀', advertisingGrade:'广告打法', recommendationGrade:'推荐能力', variantGrade:'变体运营', health:'推广健康度',
  monthlyTrend:'月流量趋势', month:'月份', natural:'自然流量', advertising:'广告流量', total:'总流量', decisionBoundaries:'判断边界',
  profitability:'盈利能力', advertisingEfficiency:'广告效率', roi:'投资回报', projectApproval:'立项判断', dataBoundary:'数据边界',
};
function reportFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reportFields);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [reportLabels[key] ?? key, reportFields(item)]));
  return value;
}
/** Builds the same published-or-current-run view as the traffic page, with all existing rows expanded. */
export function buildTrafficExportSection(context: ExportModuleContext, sources: TrafficExportSources): ExportSection {
  const blocks: ExportBlock[] = [];
  const overview: Record<string, TrafficDisplayOverview | null> = {};
  const availability: Record<string, TrafficDetailAvailability> = {};
  const monthly: Record<string, { month: string; natural: number | null; ad: number | null; total: number | null }[]> = {};
  const sourceStage = context.version?.stageOutputs.traffic;
  let sourceLabel = '当前运行流量快照';
  let updatedThrough: string | null = null;
  let listings: RecordValue = {};
  let months: RecordValue = {};
  if (context.version) {
    sourceLabel = `已发布报告 ${context.version.versionId} · 流量阶段`;
    if (sourceStage?.stage === 'traffic' && 'data' in sourceStage) {
      listings = object(sourceStage.data.listingByAsin); months = object(sourceStage.data.monthlyByAsin);
      blocks.push({ kind: 'text', text: `${sourceLabel}；阶段更新时间：${sourceStage.updatedAt}；内容版本：${sourceStage.contentHash}` });
    } else blocks.push({ kind: 'text', text: '已发布报告的流量阶段暂无已生成结果。' });
    if (sourceStage && 'gap' in sourceStage) {
      blocks.push({ kind: 'text', text: `流量阶段 ${sourceStage.stageStatus}：${sourceStage.gap.reasonCode}` });
      for (const gap of sourceStage.gap.items ?? []) if (context.asins.includes(gap.asin)) blocks.push({ kind: 'text', text: `${gap.asin}：${gap.causeCode}${gap.operation ? ` · ${gap.operation}` : ''}` });
    }
    for (const gap of context.version.gaps) if (context.asins.includes(gap.asin) && /^traffic(?:\.|$)/.test(gap.field)) blocks.push({ kind: 'text', text: `${gap.asin} · ${gap.field}：${gap.reasonCode}` });
  } else if (sources.snapshot) {
    const snapshot = sources.snapshot;
    updatedThrough = snapshot.collectedAt.slice(0,10);
    blocks.push({ kind: 'text', text: `当前运行 SIF 快照，采集时间：${snapshot.collectedAt}${snapshot.listingCollection ? `；恢复明细 ${snapshot.listingCollection.id}，采集时间：${snapshot.listingCollection.collectedAt}` : ''}` });
    for (const item of snapshot.traffic.competitors) if (context.asins.includes(item.asin)) {
      listings[item.asin] = { totalScore: item.trafficVolume, naturalAd: [{ label: '自然流量', score: item.naturalVolume, ratio: item.naturalShare }, { label: '广告流量', score: item.advertisingVolume, ratio: item.advertisingShare }], childCount: item.childCount, updatedThrough };
      months[item.asin] = { points: item.monthlyTrend };
    }
    for (const [asin, record] of Object.entries(snapshot.listingCollection?.records ?? {})) if (context.asins.includes(asin)) listings[asin] = record;
  }
  let hasData = false;
  const products = context.asins.map(asin => {
    const product = object(context.version?.catalog.find(item => object(item).asin === asin));
    return { asin, brand: typeof product.brand === 'string' ? product.brand : sources.snapshot?.traffic.competitors.find(item => item.asin === asin)?.brand ?? asin, title: product.title, image: product.image };
  });
  const domain = marketSites.find(site => site.code === context.marketplace)?.amazonDomain;
  for (const product of products) {
    const asin = product.asin;
    const raw = listings[asin];
    if (raw !== undefined) {
      const source = scopedRecord(raw, context, asin);
      if (source.naturalAd !== undefined && !TrafficListingDistributionSchema.array().safeParse(source.naturalAd).success) throw Error('流量自然/广告明细格式无效');
      const merged = mergeTrafficRecord(source);
      if (Object.values(merged.availability).includes('invalid')) throw Error('流量结构明细格式无效');
      overview[asin] = merged.overview; availability[asin] = merged.availability;
      const data = merged.overview;
      hasData = hasData || Boolean(data && (data.totalScore !== null || data.naturalAd.length || data.children.length || data.adChannels.length || data.recommendationSources.length));
      if (data) {
        if (data.updatedThrough && (!updatedThrough || data.updatedThrough > updatedThrough)) updatedThrough = data.updatedThrough;
        const identity: ExportCell = { text: `${product.brand} · ${asin}`, ...(domain ? { href: `https://${domain}/dp/${asin}` } : {}), ...(typeof product.image === 'string' ? { imageUrl: product.image } : {}) };
        blocks.push({kind:'table',title:`${asin} 父 ASIN 流量结构`,columns:['竞品','总流量分','更新至','子体数'],rows:[[identity,cell(data.totalScore),cell(data.updatedThrough),cell(data.childCount)]]});
        blocks.push(table(`${asin} 自然 / 广告流量`,['来源','流量分','占比（%）'],data.naturalAd.map(item=>[item.label,item.score,item.ratio])));
        for (const [key,label] of [['adChannels','广告流量分布'],['recommendationSources','推荐专栏来源']] as const) {
          blocks.push(table(`${asin} ${label}`,['来源','流量分','占比（%）'],data[key].map(item=>[item.label,item.score,item.ratio])));
          if (merged.availability[key] !== 'complete') blocks.push({kind:'text',text:`${asin} ${label}：${trafficDetailMessage(merged.availability[key])}`});
        }
        const children = [...data.children].sort((a,b)=>b.totalScore-a.totalScore||b.sharePct-a.sharePct||a.asin.localeCompare(b.asin));
        blocks.push({kind:'table',title:`${asin} 子体流量结构（全部已有明细）`,columns:['子体 / 属性','总流量分','父体占比（%）','自然流量','SP(常规)','SP(推荐)','SB(常规)','SBV'],rows:children.map(child=>[
          {text:`${child.asin} · ${child.label}`,...(child.image?{imageUrl:child.image}:{}),...(domain?{href:`https://${domain}/dp/${child.asin}`}:{})}, ...[child.totalScore,child.sharePct,child.organic,child.sp,child.spRecommend,child.sb,child.sbv].map(cell),
        ])});
        if (merged.availability.children !== 'complete') blocks.push({kind:'text',text:`${asin} 子体流量：${trafficDetailMessage(merged.availability.children)}`});
      }
    } else blocks.push({kind:'text',text:`${asin}：暂无已生成的父/子体流量结构。`});
    if (months[asin] !== undefined) {
      const item = scopedRecord(months[asin],context,asin);
      if (!Array.isArray(item.points)) throw Error('流量月份明细格式无效');
      const seen = new Set<string>();
      monthly[asin] = item.points.map(rawPoint=>{
        const point=object(rawPoint); if(typeof point.month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(point.month)||seen.has(point.month))throw Error('流量月份明细格式无效');seen.add(point.month);
        const natural=nonnegative(point.natural), ad=nonnegative(point.ad ?? point.advertising);
        const total=point.total === undefined ? natural!==null&&ad!==null ? natural+ad : null : nonnegative(point.total);
        return {month:point.month,natural,ad,total};
      });
      hasData = hasData || monthly[asin].length>0;
    }
    const points=monthly[asin]??[];
    blocks.push({kind:'chart',title:`${product.brand} · ${asin} 月流量趋势`,labels:points.map(point=>point.month),series:[{label:'自然流量',values:points.map(point=>point.natural)},{label:'广告流量',values:points.map(point=>point.ad)}]});
    blocks.push(table(`${asin} 全部月流量明细`,['月份','自然流量','广告流量','总流量'],points.map(point=>[point.month,point.natural,point.ad,point.total])));
  }
  blocks.push({kind:'text',text:'口径：SIF Listing 聚合、近30天流量分；广告渠道占比分母为广告总流量。页面默认折叠的子体和月份均完整保留。来源可能已限制推荐专栏 Top6 / Top N（占比≥1%等筛选），导出不再截断，无法恢复来源未保存的项目。流量分不等于访客人数或订单。'});
  blocks.push(table('广告渠道释义',['渠道','含义'],[['SP(常规)','Sponsored Product：搜索结果/商品页等常规商品推广流量'],['SP(推荐)','Sponsored Recommend：推荐场景下的商品推广流量'],['SB(常规)','Sponsored Brand：品牌广告流量'],['SBV','Sponsored Brand Video：品牌视频广告流量']]));
  const display: TrafficDisplayData={overview,monthlyTrend:{},detailAvailability:availability,meta:{source:sourceLabel,period:'近30天',country:context.marketplace,updatedThrough,status:'ready',emptyMessage:'暂无完整且可核验的流量结构明细'}};
  const conclusion=buildTrafficAnalysisConclusion(products,display);
  blocks.push({kind:'text',text:`${conclusion.title}\n${conclusion.methodNote}\n${conclusion.headline}`});
  for(const point of conclusion.corePoints)blocks.push({kind:'text',text:point});
  if (conclusion.overview.length) blocks.push(table('推广能力结论总览',['ASIN','品牌','总流量','自然 / 广告','拉量','自然沉淀','广告打法','推荐能力','变体运营','推广健康度','推广类型'],conclusion.overview.map(row=>[row.asin,row.brand,row.totalScore,row.naturalAdLabel,row.pullGrade,row.naturalGrade,row.adPlayGrade,row.recommendGrade,row.variantGrade,row.health,[row.typeLabel,row.typeSubLabel].filter(Boolean).join(' · ')])));
  for(const row of conclusion.overview) {
    blocks.push(table(`${row.asin} 推广能力依据与结论`,['维度','内容'],[['广告打法',row.adPlaySummary],['变体结构',row.variantSummary],['核心优势',row.strengths],['主要风险',row.risks],['可复制打法',row.copyable],['置信度',`${row.confidence} · ${row.confidenceReason}`],['TOP1 / TOP3 / HHI',`${row.top1Share}% / ${row.top3Share}% / ${row.hhi}`],['有效子体 / 子体数',`${row.effectiveChildren} / ${row.childCount}`],['自然流量 / 广告流量',`${row.naturalScore} / ${row.adScore}`],['推荐流量',row.recommendScore],['最大广告渠道',`${row.maxAdChannel} · ${row.maxAdChannelRatio}%`],['有效广告渠道数',row.effectiveAdChannels]]));
  }
  for(const implication of conclusion.implications)blocks.push({kind:'text',text:`对我方的启示：${implication}`});
  blocks.push({kind:'text',text:conclusion.dataBoundary});
  if(sources.report) {
    hasData=true;const report=sources.report;
    blocks.push({kind:'text',text:`已保存流量分析报告 ${report.id} · v${report.version} · ${report.status}；运行批次 ${report.runId}；Skill ${report.skill.id}@${report.skill.version}；数据截止 ${report.dataCutoffAt}。以下为原报告完整结果，未重新分析。`});
    blocks.push(exportFields('已保存流量分析报告完整结果', reportFields(report.result)));
    blocks.push(table('已保存流量分析报告依据',['证据 ID','类型','来源 ID','捕获时间'],report.evidence.map(item=>[item.id,item.type,item.sourceId,item.capturedAt])));
  } else blocks.push({kind:'text',text:'暂无当前运行的已保存流量分析报告；以上推广能力结论沿用页面纯展示计算。'});
  if(!hasData)blocks.unshift({kind:'text',text:'竞品流量分析：暂无已生成结果。'});
  return {id:'traffic',title:'竞品流量分析',status:hasData?'ready':'missing',blocks};
}
