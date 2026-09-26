"use client";
import {useMemo, useState} from "react";
import {ProductHeader, colors, type Product} from "./competitor-overview";
import {marketSites, type MarketSite} from "../../shared/market-sites";
import {useSnapshotPresentation} from "./snapshot-presentation";
import {SegmentStackBar} from "../segment-stack-bar";
import {childTrafficSegmentMeta, childTrafficSegments, sifAdChannelGlossary, sifAdChannelGlossaryList, type TrafficDisplayItem, type ChildTrafficVariant, type TrafficDisplayData} from "../sif-listing-traffic-data";
import {sifMonthlyTrafficMeta} from "../sif-monthly-traffic-trend-data";
import {formatTrafficScore, formatTrafficPercent, trafficChildCountLabel, trafficDetailMessage, type TrafficFieldState} from "../lib/traffic-detail-view";
import {buildTrafficAnalysisConclusion, type TrafficHealth} from "../traffic-analysis-conclusion";
import {amazonMediaSrc} from "../lib/amazon-image";

export type TrafficSnapshotSeries = {asin:string; points:{month:string; label:string; natural:number|null; ad:number|null; total:number|null}[]};
export type TrafficReportViewProps = {products:Product[]; market:MarketSite; trafficData:TrafficDisplayData; monthlyTrendByAsin?:Record<string,TrafficSnapshotSeries>};
function SourceBadge({children}:{children:React.ReactNode}) {return <span className="source-badge">{children}</span>;}

function TrafficDistributionBars({ items, palette, maxItems, glossary, state }: {
  items: TrafficDisplayItem[];
  palette: string[];
  maxItems?: number;
  glossary?: Record<string, { en: string; meaning: string }>;
  state?: TrafficFieldState;
}) {
  const visible = maxItems ? items.slice(0, maxItems) : items;
  if (!visible.length) return <div className="traffic-dist-empty"><strong>—</strong><span>{trafficDetailMessage(state)}</span></div>;
  return (
    <div className="traffic-dist-bars">
      {visible.map((item, index) => {
        const tip = glossary?.[item.label];
        const title = tip
          ? `${item.label} · ${tip.en}\n${tip.meaning}\n${formatTrafficScore(item.score)} · ${formatTrafficPercent(item.ratio)}`
          : `${item.label} · ${formatTrafficScore(item.score)} · ${formatTrafficPercent(item.ratio)}`;
        return (
          <div key={item.label} title={title}>
            <span title={title}>{item.label}</span>
            <i><b style={{ width: `${Math.max(0, Math.min(100, item.ratio ?? 0))}%`, background: palette[index % palette.length] }} /></i>
            <strong>{formatTrafficScore(item.score)}</strong>
            <em>{formatTrafficPercent(item.ratio)}</em>
          </div>
        );
      })}
    </div>
  );
}

function ChildTrafficStructurePanel({ variants, state }: { variants: ChildTrafficVariant[]; state?: TrafficFieldState }) {
  const previewCount = 3;
  const [expanded, setExpanded] = useState(false);
  const snapshot = useSnapshotPresentation();
  const ranked = [...variants].sort((a, b) => b.totalScore - a.totalScore || b.sharePct - a.sharePct);
  if (!ranked.length) {
    return <div className="traffic-dist-empty"><strong>—</strong><span>{trafficDetailMessage(state)}</span></div>;
  }
  const visible = expanded ? ranked : ranked.slice(0, previewCount);
  const hiddenCount = Math.max(0, ranked.length - previewCount);
  const maxScore = Math.max(...ranked.map(child => child.totalScore), 1);
  return (
    <div className="child-traffic-structure">
      <div className="child-traffic-legend">
        {childTrafficSegmentMeta.map(item => {
          const tip = sifAdChannelGlossary[item.label];
          return (
            <span key={item.key} title={tip ? `${item.label} · ${tip.en}\n${tip.meaning}` : item.label}>
              <i style={{ background: item.color }} />{item.label}
            </span>
          );
        })}
      </div>
      <div className="child-traffic-rows">
        {visible.map((child, index) => {
          const segments = childTrafficSegments(child);
          return (
            <div className="child-traffic-row" key={child.asin}>
              <div className="child-traffic-meta">
                {child.image && <img src={amazonMediaSrc(child.image)} alt="" referrerPolicy="no-referrer" />}
                <div>
                  <b>#{index + 1} · {child.label}</b>
                  <small>{child.asin}</small>
                </div>
                <em title={formatTrafficPercent(child.sharePct)}>{formatTrafficPercent(child.sharePct)}</em>
              </div>
              <div className="child-traffic-bar-wrap" style={{ width: `${Math.max(18, (child.totalScore / maxScore) * 100)}%` }}>
                <SegmentStackBar segments={segments} hideSegmentTitle={false} />
                <strong title={formatTrafficScore(child.totalScore)}>{formatTrafficScore(child.totalScore)}</strong>
              </div>
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 && snapshot ? <details className="traffic-child-details"><summary>展开其余 {hiddenCount} 个子体</summary>{ranked.slice(previewCount).map((child,index) => <ChildTrafficRow key={child.asin} child={child} index={index + previewCount} maxScore={maxScore} />)}</details> : null}
      {hiddenCount > 0 && !snapshot ? (
        <button type="button" className="variant-detail-toggle" onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起子体" : `展开其余 ${hiddenCount} 个子体`}
        </button>
      ) : null}
    </div>
  );
}

function ChildTrafficRow({child,index,maxScore}:{child:ChildTrafficVariant;index:number;maxScore:number}) {
  return <div className="child-traffic-row">
    <div className="child-traffic-meta">
      {child.image && <img src={amazonMediaSrc(child.image)} alt="" referrerPolicy="no-referrer" />}
      <div><b>#{index + 1} · {child.label}</b><small>{child.asin}</small></div>
      <em title={formatTrafficPercent(child.sharePct)}>{formatTrafficPercent(child.sharePct)}</em>
    </div>
    <div className="child-traffic-bar-wrap" style={{width:`${Math.max(18,(child.totalScore/maxScore)*100)}%`}}>
      <SegmentStackBar segments={childTrafficSegments(child)} hideSegmentTitle={false}/>
      <strong title={formatTrafficScore(child.totalScore)}>{formatTrafficScore(child.totalScore)}</strong>
    </div>
  </div>;
}

type MonthlyTrafficHover = {
  x: number;
  month: string;
  brand: string;
  asin: string;
  natural: number | null;
  ad: number | null;
  total: number | null;
  brandColor: string;
};

function MonthlyTrafficStackChart({
  products,
  monthlyTrendByAsin = {},
}: {
  products: Product[];
  monthlyTrendByAsin?: Record<string, TrafficSnapshotSeries>;
}) {
  const [hover, setHover] = useState<MonthlyTrafficHover | null>(null);
  const width = 980;
  const height = 300;
  const padL = 52;
  const padR = 18;
  const padT = 18;
  const padB = 44;
  const plotH = height - padT - padB;
  const snapshot = useSnapshotPresentation();
  const brandCounts = products.reduce<Record<string, number>>((acc, product) => {
    acc[product.brand] = (acc[product.brand] ?? 0) + 1;
    return acc;
  }, {});
  const series = products
    .map((product, index) => ({
      product,
      color: colors[index],
      label: brandCounts[product.brand] > 1 ? `${product.brand} · ${product.asin.slice(-4)}` : product.brand,
      points: monthlyTrendByAsin[product.asin]?.points ?? [],
    }))
    .filter(item => item.points.length);

  if (!series.length) return <div className="empty-chart">{snapshot ? "暂无已保存月流量结构数据" : "等待 SIF 月流量结构数据"}</div>;

  const monthCount = Math.max(...series.map(item => item.points.length));
  const brandCount = series.length;
  const maxTotal = Math.max(...series.flatMap(item => item.points.map(point =>
    point.natural !== null && point.ad !== null && point.total !== null
      ? Math.max(point.total, point.natural + point.ad) : 0)), 1);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(ratio => Math.round(maxTotal * ratio));
  const chartWidth = snapshot
    ? Math.max(width, padL + padR + brandCount * Math.max(180, monthCount * 10 + 64))
    : Math.max(width, padL + padR + brandCount * (monthCount * 10 + 64));
  const chartPlotW = chartWidth - padL - padR;
  const groupGap = chartPlotW / brandCount;
  const barGap = 2;
  const barWidth = Math.min(16, Math.max(8, (groupGap * 0.78 - barGap * (monthCount - 1)) / monthCount));
  const clusterWidth = monthCount * barWidth + (monthCount - 1) * barGap;
  const yFor = (value: number) => padT + plotH * (1 - value / maxTotal);

  return (
    <div className="comparison-chart monthly-traffic-stack-chart">
      <div className="chart-stage" style={{overflowX:"auto"}}>
        <svg viewBox={`0 0 ${chartWidth} ${height}`} width={chartWidth} height={height} style={snapshot && chartWidth > width ? {minWidth:chartWidth} : undefined} role="img" aria-label="按品牌自然广告堆叠柱图" onMouseLeave={() => setHover(null)}>
          {yTicks.map((tick, index) => {
            const y = yFor(tick);
            return (
              <g key={tick}>
                <line x1={padL} x2={chartWidth - padR} y1={y} y2={y} stroke="#E7ECF2" strokeDasharray="4 5" />
                <text x={padL - 8} y={y + 3} textAnchor="end" className="monthly-traffic-axis-label">{index === 0 ? "0" : tick.toLocaleString()}</text>
              </g>
            );
          })}
          {series.map((item, brandIndex) => {
            const groupCenter = padL + groupGap * brandIndex + groupGap / 2;
            const clusterLeft = groupCenter - clusterWidth / 2;
            return (
              <g key={item.product.asin}>
                {item.points.map((point, monthIndex) => {
                  const monthLabel = point.label || point.month;
                  const x = clusterLeft + monthIndex * (barWidth + barGap);
                  const complete = point.natural !== null && point.ad !== null && point.total !== null;
                  const naturalH = ((point.natural ?? 0) / maxTotal) * plotH;
                  const adH = ((point.ad ?? 0) / maxTotal) * plotH;
                  const naturalY = padT + plotH - naturalH;
                  const adY = naturalY - adH;
                  const stackH = Math.max(naturalH + adH, 0);
                  const gap = naturalH > 1.5 && adH > 1.5 ? 1.2 : 0;
                  return (
                    <g
                      key={`${item.product.asin}-${point.month}`}
                      className="monthly-traffic-bar"
                      onMouseMove={() => setHover({
                        x: x + barWidth / 2,
                        month: monthLabel,
                        brand: item.label,
                        asin: item.product.asin,
                        natural: point.natural,
                        ad: point.ad,
                        total: point.total,
                        brandColor: item.color,
                      })}
                    >
                      <title>{`${item.label} · ${point.month}：自然 ${formatTrafficScore(point.natural)}，广告 ${formatTrafficScore(point.ad)}，合计 ${formatTrafficScore(point.total)}`}</title>
                      {complete ? <><rect
                        x={x}
                        y={naturalY}
                        width={barWidth}
                        height={Math.max(naturalH - gap / 2, 0)}
                        fill={sifMonthlyTrafficMeta.naturalColor}
                        rx="2"
                      />
                      <rect
                        x={x}
                        y={adY}
                        width={barWidth}
                        height={Math.max(adH - gap / 2, 0)}
                        fill={sifMonthlyTrafficMeta.adColor}
                        rx="2"
                      />
                      <rect x={x} y={adY} width={barWidth} height={stackH} fill="transparent" /></> :
                        <text x={x + barWidth / 2} y={padT + plotH - 8} textAnchor="middle" className="monthly-traffic-missing">—</text>}
                      <text
                        x={x + barWidth / 2}
                        y={height - 26}
                        textAnchor="middle"
                        className="monthly-traffic-month-tick"
                      >
                        {monthLabel.replace("月", "")}
                      </text>
                    </g>
                  );
                })}
                <line
                  x1={clusterLeft}
                  x2={clusterLeft + clusterWidth}
                  y1={padT + plotH + 1}
                  y2={padT + plotH + 1}
                  stroke={item.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  opacity="0.85"
                />
                <text x={groupCenter} y={height - 8} textAnchor="middle" className="monthly-traffic-brand-label">
                  {item.label}
                </text>
              </g>
            );
          })}
        </svg>
        {!snapshot && hover && (
          <div
            className="chart-tooltip chart-tooltip-group monthly-traffic-tooltip"
            style={{
              left: `${(hover.x / width) * 100}%`,
              top: "12px",
              transform: hover.x / width < 0.2 ? "translateX(0)" : hover.x / width > 0.8 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            <b className="chart-tooltip-title">{hover.brand} · {hover.month}</b>
            <div className="chart-tooltip-row"><span><i style={{ background: sifMonthlyTrafficMeta.naturalColor }} />自然流量</span><strong>{formatTrafficScore(hover.natural)}</strong></div>
            <div className="chart-tooltip-row"><span><i style={{ background: sifMonthlyTrafficMeta.adColor }} />广告流量</span><strong>{formatTrafficScore(hover.ad)}</strong></div>
            <div className="chart-tooltip-row"><span><i style={{ background: hover.brandColor }} />合计</span><strong>{formatTrafficScore(hover.total)}</strong></div>
          </div>
        )}
      </div>
      {snapshot && <details className="traffic-monthly-details"><summary>查看全部 {series.reduce((count,item)=>count+item.points.length,0)} 条已保存月份明细</summary><div className="matrix-wrap"><table className="compare-matrix"><thead><tr><th>竞品</th><th>月份</th><th>自然流量</th><th>广告流量</th><th>合计</th></tr></thead><tbody>{series.flatMap(item=>item.points.map(point=><tr key={`${item.product.asin}-${point.month}`}><th>{item.label} · {item.product.asin}</th><td>{point.month}</td><td>{formatTrafficScore(point.natural)}</td><td>{formatTrafficScore(point.ad)}</td><td>{formatTrafficScore(point.total)}</td></tr>))}</tbody></table></div></details>}
    </div>
  );
}

function healthClass(health: TrafficHealth) {
  if (health === "健康") return "health-good";
  if (health === "基本健康") return "health-ok";
  if (health === "需观察") return "health-watch";
  return "health-risk";
}

export function TrafficAnalysisConclusionSection({
  products,
  market,
  trafficData,
}: {
  products: Product[];
  market: MarketSite;
  trafficData: TrafficDisplayData;
}) {
  const conclusion = useMemo(
    () => buildTrafficAnalysisConclusion(products.map(p => ({ asin: p.asin, brand: p.brand })), trafficData),
    [products, trafficData],
  );
  const productByAsin = useMemo(
    () => Object.fromEntries(products.map((p, index) => [p.asin, { product: p, index }])),
    [products],
  );
  const marketInfo = marketSites.find(site=>site.code===market)!;

  return (
    <section className="card traffic-conclusion-card">
      <div className="section-head">
        <div>
          <h3>{conclusion.title}</h3>
          <p>{conclusion.methodNote}</p>
        </div>
        <SourceBadge>流量结构技能 · SIF</SourceBadge>
      </div>

      <div className="traffic-conclusion-hero">
        <span className="status-chip">推广能力判断</span>
        <h4>{conclusion.headline}</h4>
        <ul className="traffic-conclusion-core">
          {conclusion.corePoints.map(point => <li key={point}>{point}</li>)}
        </ul>
      </div>

      {conclusion.overview.length > 0 && (
        <div className="matrix-wrap traffic-conclusion-table-wrap">
          <table className="compare-matrix traffic-conclusion-table">
            <colgroup>
              <col className="col-product" />
              <col className="col-total" />
              <col className="col-structure" />
              <col className="col-grade" />
              <col className="col-grade" />
              <col className="col-grade" />
              <col className="col-grade" />
              <col className="col-health" />
              <col className="col-type" />
            </colgroup>
            <thead>
              <tr>
                <th>竞品</th>
                <th>总流量</th>
                <th>自然 / 广告</th>
                <th>拉量</th>
                <th>自然沉淀</th>
                <th>广告打法</th>
                <th>变体运营</th>
                <th>推广健康度</th>
                <th>推广类型</th>
              </tr>
            </thead>
            <tbody>
              {conclusion.overview.map(row => {
                const matched = productByAsin[row.asin];
                const product = matched?.product;
                const index = matched?.index ?? 0;
                return (
                  <tr key={row.asin}>
                    <th>
                      <div className="traffic-conclusion-product">
                        <span className="series-dot" style={{ background: colors[index % colors.length] }}>{index + 1}</span>
                        {product?.image
                          ? <img src={amazonMediaSrc(product.image)} alt={row.brand} referrerPolicy="no-referrer" />
                          : <div className="image-placeholder">ASIN</div>}
                        <div>
                          <b>{row.brand}</b>
                          <a
                            className="asin-link"
                            href={`https://${marketInfo.amazonDomain}/dp/${row.asin}`}
                            target="_blank"
                            rel="noreferrer"
                            title={`打开 Amazon ${marketInfo.label}商品页`}
                          >
                            {row.asin}<span>↗</span>
                          </a>
                        </div>
                      </div>
                    </th>
                    <td><strong>{row.totalScore.toLocaleString()}</strong></td>
                    <td><b>{row.naturalAdLabel}</b></td>
                    <td>{row.pullGrade}</td>
                    <td>{row.naturalGrade}</td>
                    <td>{row.adPlayGrade}</td>
                    <td>{row.variantGrade}</td>
                    <td><span className={`traffic-health-pill ${healthClass(row.health)}`}>{row.health}</span></td>
                    <td>
                      <b>{row.typeLabel}</b>
                      {row.typeSubLabel ? <small>{row.typeSubLabel}</small> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="traffic-conclusion-detail-grid">
        {conclusion.overview.map(row => {
          const matched = productByAsin[row.asin];
          const product = matched?.product;
          const index = matched?.index ?? 0;
          return (
            <article key={`detail-${row.asin}`} className="traffic-conclusion-detail">
              <header>
                <div className="traffic-conclusion-product">
                  <span className="series-dot" style={{ background: colors[index % colors.length] }}>{index + 1}</span>
                  {product?.image
                    ? <img src={amazonMediaSrc(product.image)} alt={row.brand} referrerPolicy="no-referrer" />
                    : <div className="image-placeholder">ASIN</div>}
                  <div>
                    <b>{row.brand}</b>
                    <a
                      className="asin-link"
                      href={`https://${marketInfo.amazonDomain}/dp/${row.asin}`}
                      target="_blank"
                      rel="noreferrer"
                      title={`打开 Amazon ${marketInfo.label}商品页`}
                    >
                      {row.asin}<span>↗</span>
                    </a>
                  </div>
                </div>
                <span className={`traffic-health-pill ${healthClass(row.health)}`}>{row.health}</span>
              </header>
              <p><em>推广类型</em>{row.typeLabel}{row.typeSubLabel ? ` · ${row.typeSubLabel}` : ""}</p>
              <p><em>流量结构</em>总流量 {row.totalScore.toLocaleString()}，自然/广告 {row.naturalAdLabel}。</p>
              <p><em>广告打法</em>{row.adPlaySummary}</p>
              <p><em>变体结构</em>{row.variantSummary}</p>
              <p><em>核心优势</em>{row.strengths}</p>
              <p><em>主要风险</em>{row.risks}</p>
              <p><em>可复制打法</em>{row.copyable}</p>
              <small>置信度 {row.confidence} · {row.confidenceReason}</small>
            </article>
          );
        })}
      </div>

      <div className="traffic-conclusion-implications">
        <b>对我方的启示</b>
        <ul>
          {conclusion.implications.map(item => <li key={item}>{item}</li>)}
        </ul>
        <p className="traffic-data-note">{conclusion.dataBoundary}</p>
      </div>
    </section>
  );
}


export function TrafficReportView({products,market,trafficData,monthlyTrendByAsin}:TrafficReportViewProps) {
  const snapshot = useSnapshotPresentation();
  return <>
        <section className="card page-intro"><div><span className="status-chip">竞品流量分析</span><h2>同屏比较流量结构、月趋势，并输出推广能力结论</h2><p>数据来自 SIF「查流量结构」· {trafficData.meta.period} · 更新至 {trafficData.meta.updatedThrough}，统一 Listing 口径。</p></div>
          <SourceBadge>SIF MCP</SourceBadge>
        </section>

        <section className="card listing-traffic-distribution">
          <div className="section-head">
            <div>
              <h3>父 ASIN 流量结构</h3>
              <p>Listing 聚合 · 自然 / 广告占比 · 广告渠道 · 推荐专栏来源</p>
            </div>
            <SourceBadge>SIF MCP</SourceBadge>
          </div>
          <div className="traffic-distribution-scroll">
            <div className="traffic-distribution-grid">
              <div className="traffic-distribution-head">
                <span>竞品</span>
                <span>Listing自然 / 广告流量分布</span>
                <span title="悬停各渠道标签可查看 SIF 字段释义">广告流量分布</span>
                <span>推荐专栏流量分布</span>
              </div>
              {products.map((p, i) => {
                const data = trafficData.overview[p.asin];
                return (
                  <div className="traffic-distribution-row" key={p.asin}>
                    <div className="traffic-product-cell">
                      <ProductHeader product={p} index={i} market={market} />
                      {data && <small>总分 {formatTrafficScore(data.totalScore)} · 更新至 {data.updatedThrough ?? "未提供"}</small>}
                    </div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars items={data?.naturalAd ?? []} palette={["#55BB6A", "#FFB03B"]} /></div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars state={trafficData.detailAvailability?.[p.asin]?.adChannels} items={data?.adChannels ?? []} glossary={sifAdChannelGlossary} palette={["#538CEE", "#FFB03B", "#F15C5C", "#55BB6A"]} /></div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars state={trafficData.detailAvailability?.[p.asin]?.recommendationSources} items={data?.recommendationSources ?? []} maxItems={6} palette={["#538CEE", "#55BB6A", "#FFB03B", "#F15C5C"]} />{snapshot && (data?.recommendationSources?.length ?? 0) >= 6 && <small>推荐来源仅展示已保存的前 6 项；来源可能设有 Top N 或占比门槛。</small>}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="traffic-channel-glossary">
            {sifAdChannelGlossaryList.map(item => (
              <span key={item.label} title={`${item.en} · ${item.meaning}`}>
                <b>{item.label}</b>
                <em>{item.en}</em>
                <small>{item.meaning}</small>
              </span>
            ))}
          </div>
          <p className="traffic-data-note">口径对齐 SIF 查流量结构 · Listing 聚合视图 · 近30天流量分 · 广告渠道释义来自 SIF MCP wholeName 与查流量结构文档。</p>
        </section>

        <section className="card child-traffic-distribution">
          <div className="section-head">
            <div>
              <h3>子体流量结构</h3>
              <p>默认展示流量 TOP3 子体 · 其余折叠 · 条长按总分缩放</p>
            </div>
            <SourceBadge>SIF MCP</SourceBadge>
          </div>
          <div className="child-traffic-compare-grid">
            {products.map((p, i) => {
              const data = trafficData.overview[p.asin];
              return (
                <div className="child-traffic-card" key={p.asin}>
                  <div className="child-traffic-card-head">
                    <ProductHeader product={p} index={i} market={market} />
                    <small>{trafficChildCountLabel(data, trafficData.detailAvailability?.[p.asin]?.children)} · 总分 {formatTrafficScore(data?.totalScore)}</small>
                  </div>
                  <ChildTrafficStructurePanel variants={data?.children ?? []} state={trafficData.detailAvailability?.[p.asin]?.children} />
                </div>
              );
            })}
          </div>
        </section>

        <section className="card compare-chart-card monthly-traffic-card">
          <div className="section-head">
            <div>
              <h3>月流量趋势对比</h3>
              <p>按品牌分组 · 自然 / 广告堆叠柱 · 更新至 {trafficData.meta.updatedThrough}</p>
            </div>
            <SourceBadge>SIF MCP</SourceBadge>
          </div>
          <div className="monthly-traffic-legends">
            <div className="chart-legend">
              <span><i style={{ background: sifMonthlyTrafficMeta.naturalColor }} />自然流量</span>
              <span><i style={{ background: sifMonthlyTrafficMeta.adColor }} />广告流量</span>
            </div>
            <div className="chart-legend">
              {products.map((p, i) => <span key={p.asin}><i style={{ background: colors[i] }} />{p.brand}</span>)}
            </div>
          </div>
          <MonthlyTrafficStackChart products={products} monthlyTrendByAsin={monthlyTrendByAsin ?? trafficData.monthlyTrend} />
          <p className="traffic-data-note">{snapshot ? "父 ASIN Listing 聚合口径；展示当前来源已保存的月份，未提供的数值以“—”表示。" : sifMonthlyTrafficMeta.note}</p>
        </section>

        <TrafficAnalysisConclusionSection products={products} market={market} trafficData={trafficData} />
  </>;
}
