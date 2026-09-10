"use client";

import { type TrafficHealth, buildTrafficAnalysisConclusion } from "./traffic-analysis-conclusion";
import { type TrafficDisplayData } from "../../sif-listing-traffic-data";
import { useMemo } from "react";
import { amazonMediaSrc } from "../../lib/amazon-image";
import { type Product, type MarketCode, markets } from "../catalog/product-contracts";
import { SourceBadge } from "../../components/source-badge";
import { colors } from "../charts/chart-format";

export function healthClass(health: TrafficHealth) {
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
  market: MarketCode;
  trafficData?: TrafficDisplayData;
}) {
  const conclusion = useMemo(
    () => buildTrafficAnalysisConclusion(products.map(p => ({ asin: p.asin, brand: p.brand })), trafficData),
    [products, trafficData],
  );
  const productByAsin = useMemo(
    () => Object.fromEntries(products.map((p, index) => [p.asin, { product: p, index }])),
    [products],
  );
  const marketInfo = markets[market];

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
                            href={`https://${marketInfo.domain}/dp/${row.asin}`}
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
                      href={`https://${marketInfo.domain}/dp/${row.asin}`}
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
