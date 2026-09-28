"use client";

import { LaunchSection, LaunchTable } from "./launch-section";
import React from 'react';
import type {MarketKeywordOriginalEstimate} from '../shared/market-keyword-original-estimate-contracts';
type AmazonKeywordDemandReport=MarketKeywordOriginalEstimate['report'];
type KeywordDemandCluster=AmazonKeywordDemandReport['synthesis']['clusters'][number];
type KeywordDemandDimensionSummary=AmazonKeywordDemandReport['dimensions']['w1'];

function formatNum(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return Math.round(value).toLocaleString();
}

function formatPct(value: number | null | undefined, digits = 1) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

function DimensionSection({ dimension }: { dimension: KeywordDemandDimensionSummary }) {
  return (
    <LaunchSection
      title={`${dimension.title} · ${dimension.question}`}
      description={dimension.dataQuality}
      className="kw-demand-dimension-section"
    >
      <p className="launch-conclusion-lead">
        <strong>结论：</strong>
        {dimension.conclusion}
      </p>
      {dimension.rows.length ? (
        <LaunchTable className="launch-conclusion-table kw-launch-section-table">
          <thead>
            <tr>
              <th>{dimension.id === "W5" ? "关键词" : "标签"}</th>
              <th>代表词</th>
              <th>月搜索量</th>
              <th>样本占比</th>
              {dimension.id === "W5" ? <th>增速（近N月窗口）</th> : null}
            </tr>
          </thead>
          <tbody>
            {dimension.rows.map(row => (
              <tr key={`${dimension.id}-${row.label}`}>
                <th>{row.label}</th>
                <td className="launch-muted">{row.keywords.slice(0, 4).join("、")}</td>
                <td>{formatNum(row.monthlySearches)}</td>
                <td>{formatPct(row.sharePct)}</td>
                {dimension.id === "W5" ? <td className="launch-muted">{row.note ?? "—"}</td> : null}
              </tr>
            ))}
          </tbody>
        </LaunchTable>
      ) : (
        <div className="pending-box">当前样本未识别到该维度有效词素</div>
      )}
    </LaunchSection>
  );
}

function ClusterMiniTable({ rows }: { rows: KeywordDemandCluster[] }) {
  if (!rows.length) {
    return <div className="pending-box">当前样本未识别到可开发需求簇</div>;
  }

  return (
    <LaunchTable className="launch-conclusion-table kw-launch-section-table">
      <thead>
        <tr>
          <th>需求簇</th>
          <th>五维表达式</th>
          <th>代表关键词</th>
          <th>规模</th>
          <th>类型</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id}>
            <th>{row.name}</th>
            <td className="launch-muted">
              W1({row.w1What})
              {row.w3Where ? ` + W3(${row.w3Where})` : ""}
              {row.w2Who ? ` + W2(${row.w2Who})` : ""}
              {row.w4Features.length ? ` + W4(${row.w4Features.join("/")})` : ""}
            </td>
            <td className="launch-muted">{row.keywords.slice(0, 3).join("、")}</td>
            <td>
              {formatNum(row.monthlySearches)}
              <small> · {formatPct(row.computed.sharePct)}</small>
            </td>
            <td>{row.computed.demandClass}</td>
          </tr>
        ))}
      </tbody>
    </LaunchTable>
  );
}

function ArchiveDemandSummary({ report }: { report: AmazonKeywordDemandReport }) {
  if (report.status === "insufficient_data") {
    return (
      <LaunchSection title="关键词需求分析" description="按原版有效样本分析">
        <div className="pending-box">暂无足够关键词样本，请先完成查询。</div>
      </LaunchSection>
    );
  }

  const { dimensions, synthesis } = report;

  return (
    <>
      <section className="card launch-block launch-verdict-block kw-launch-verdict launch-verdict conditional st-keyword-demand-summary">
        <div className="launch-section-head">
          <div className="launch-section-head-main">
            <span className="status-chip">关键词需求分析 · 原版规则</span>
            <h3>
              {report.scope.productScope} · {report.scope.marketplace} · 五维需求分析 W1–W5
            </h3>
            <p>
              基于 {report.scope.sampleCount} 条有效扩展词 · 月搜索量合计 {formatNum(report.scope.totalMonthlyVolume)} ·
              数据源 {report.scope.source}
            </p>
          </div>
          <span className={`kw-grade-badge grade-${report.status === "ok" ? "b" : "c"}`}>
            {`已有趋势 ${report.scope.trendEnrichedCount}/${report.scope.sampleCount}`}
          </span>
        </div>
        <div className="launch-section-body">
          {report.sampleWarning ? <p className="ss-market-query-error">{report.sampleWarning}</p> : null}
          <ul className="launch-reason-list kw-data-gaps">
            {report.dataNotes.map(note => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      </section>

      <LaunchSection title="五维综合结论" description="W1–W5 合成 · 规模优先看 W1+W3，差异化看 W4">
        <p className="launch-conclusion-lead">
          <strong>{synthesis.headline}</strong>
        </p>
        <ul className="launch-reason-list">
          {synthesis.bullets.map(bullet => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      </LaunchSection>

      <DimensionSection dimension={dimensions.w1} />
      <DimensionSection dimension={dimensions.w2} />
      <DimensionSection dimension={dimensions.w3} />
      <DimensionSection dimension={dimensions.w4} />
      <DimensionSection dimension={dimensions.w5} />

      <LaunchSection title="需求簇合成" description="按原版归并 · 主流/细分判定">
        <ClusterMiniTable rows={synthesis.clusters} />
      </LaunchSection>
    </>
  );
}

export function MarketKeywordOriginalEstimateReport({estimate,manual=false}:{estimate:MarketKeywordOriginalEstimate;manual?:boolean}){
 const {report}=estimate,clusters=report.synthesis.clusters;
 const score=(value:number)=>value.toLocaleString('zh-CN',{maximumFractionDigits:2});
 return <section aria-label="原版关键词业务报告" className="market-keyword-report-stack">
  <section className="card launch-block"><div className="launch-section-body"><strong>原版规则 · 估算评分</strong><p>采集词池 {estimate.totalKeywordCount} 词，纳入有效样本 {report.scope.sampleCount} 词，缺少来源月搜索量排除 {estimate.excludedKeywordIds.length} 词。规模统计月份未注明，采用来源页月搜索量；参考月趋势值保留在上方事实明细。</p>{estimate.notes.map(note=><p className="market-research-note" key={note}>{note}</p>)}</div></section>
  {!manual&&<ArchiveDemandSummary report={report}/>}
  <LaunchSection title="原版估算评分" description="S1 规模 · S2 增长 · S3 竞争 · S4 执行成本 · S5 价值空间">
   <p>分数是样本内相对排名，不是增长率或成功概率。PVS = 28% S1 + 22% S2 + 20% S3 + 18% S4 + 12% S5。</p>
   {clusters.length?<LaunchTable className="launch-conclusion-table kw-launch-section-table"><thead><tr><th>需求簇</th><th>S1 规模</th><th>S2 增长</th><th>S3 竞争</th><th>S4 执行成本</th><th>S5 价值空间</th><th>PVS</th><th>类型 / 象限</th><th>估算依据</th></tr></thead><tbody>{clusters.map(c=><tr key={c.id}><th>{c.name}</th><td>{score(c.computed.s1)}</td><td>{score(c.computed.s2)}</td><td>50 <small>估算</small></td><td>{score(c.computed.s4)} <small>含估算</small></td><td>50 <small>估算</small></td><td><strong>{score(c.computed.pvs)}</strong></td><td>{c.computed.demandClass} · {c.computed.quadrant}</td><td><details><summary>查看依据</summary><p>历史增长 {c.yoyGrowth===null?'缺失':formatPct(c.yoyGrowth*100)}；近三月增长 {c.growth3m===null?'缺失':formatPct(c.growth3m*100)}；来源推荐竞价 {c.ppcBid===null?'缺失，按原版中位数回退':score(c.ppcBid)}。</p><p>S2 缺一项增长时使用另一项；两项都缺时以 0 参与排名。S4 使用低竞价优先排名与中性 50 分各占一半。</p><p>评分占比 {formatPct(c.computed.sharePct)} 为归并前口径；归并后展示规模 {formatNum(c.monthlySearches)}。</p>{c.computed.warnings.map(w=><p key={w}>{w}</p>)}</details></td></tr>)}</tbody></LaunchTable>:<div className="pending-box">当前没有可评分的有效需求簇；来源明细和已保存报告继续保留。</div>}
  </LaunchSection>
  <LaunchSection title="产品开发方向" description="按原版选择 P1/P2 的前 6 个方向，属于验证建议">
   {report.developmentDirections.length?<LaunchTable><thead><tr><th>方向</th><th>证据</th><th>优先级</th><th>可行性</th></tr></thead><tbody>{report.developmentDirections.map((r,i)=><tr key={i}><th>{r.direction}</th><td>{r.evidence}</td><td>{r.priority}</td><td>{r.feasibility}</td></tr>)}</tbody></LaunchTable>:<div className="pending-box">当前原版评分未筛出 P1/P2 开发方向。</div>}
  </LaunchSection>
  <LaunchSection title="验证优先级" description="按原版估算等级给出验证方式与周期，不代表已验证可行">
   {report.validationPriorities.length?<LaunchTable><thead><tr><th>需求假设</th><th>优先级</th><th>验证方式</th><th>周期</th></tr></thead><tbody>{report.validationPriorities.map((r,i)=><tr key={i}><th>{r.hypothesis}</th><td>{r.tier}</td><td>{r.method}</td><td>{r.effort}</td></tr>)}</tbody></LaunchTable>:<div className="pending-box">当前没有符合原版筛选条件的验证项。</div>}
  </LaunchSection>
 </section>;
}
