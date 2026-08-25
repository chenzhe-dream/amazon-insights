"use client";

import { amazonMediaSrc } from "./lib/amazon-image";
import {
  sorftimeListingContentData,
  sorftimeListingContentMeta,
} from "./sorftime-listing-content-data";

type ProductRef = {
  asin: string;
  brand: string;
  title: string;
  image: string;
};

type MarketInfo = {
  label: string;
  domain: string;
};

function statusBadge(value: boolean | null | undefined, yes = "已配置", no = "未配置", unknown = "待同步") {
  if (value === true) return <span className="listing-aplus-yes">{yes}</span>;
  if (value === false) return <span className="listing-aplus-no">{no}</span>;
  return <span className="listing-aplus-unknown">{unknown}</span>;
}

export function ListingAplusSection({
  products,
  market,
  colors,
  listingByAsin = sorftimeListingContentData,
}: {
  products: ProductRef[];
  market: MarketInfo;
  colors: string[];
  listingByAsin?: typeof sorftimeListingContentData;
}) {
  return (
    <section className="card listing-aplus-card">
      <div className="section-head">
        <div>
          <h3>高级 A+ / 富内容对比</h3>
          <p>
            Sorftime · a_plus · 卖家精灵 · EBC / 视频 / LQS · MCP 暂不提供 Premium A+ 模块截图，请通过 Listing 链接核验 ·
            同步至 {sorftimeListingContentMeta.updatedAt}
          </p>
        </div>
        <span className="source-badge">Sorftime + 卖家精灵</span>
      </div>
      <div className="matrix-wrap">
        <table className="compare-matrix listing-aplus-matrix">
          <thead>
            <tr>
              <th>指标</th>
              {products.map((product, index) => {
                const image = amazonMediaSrc(
                  listingByAsin[product.asin]?.mainImage || product.image,
                );
                return (
                <th key={product.asin}>
                  <div className="compare-product-head">
                    <span className="series-dot" style={{ background: colors[index % colors.length] }}>
                      {index + 1}
                    </span>
                    {image ? (
                      <img src={image} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="image-placeholder">ASIN</div>
                    )}
                    <div>
                      <b>{product.brand}</b>
                      <a
                        className="asin-link"
                        href={`https://${market.domain}/dp/${product.asin}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {product.asin}
                        <span>↗</span>
                      </a>
                    </div>
                  </div>
                </th>
              );
              })}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>A+ 内容</th>
              {products.map(product => {
                const record = listingByAsin[product.asin];
                return (
                  <td key={product.asin}>{statusBadge(record?.hasAplus, "有 A+", "无 A+")}</td>
                );
              })}
            </tr>
            <tr>
              <th>EBC / 品牌内容</th>
              {products.map(product => {
                const record = listingByAsin[product.asin];
                return <td key={product.asin}>{statusBadge(record?.hasEbc, "已配置", "未配置")}</td>;
              })}
            </tr>
            <tr>
              <th>主图视频</th>
              {products.map(product => {
                const record = listingByAsin[product.asin];
                return <td key={product.asin}>{statusBadge(record?.hasVideo, "有视频", "无视频")}</td>;
              })}
            </tr>
            <tr>
              <th>LQS 质量分</th>
              {products.map(product => {
                const record = listingByAsin[product.asin];
                return (
                  <td key={product.asin}>
                    {record?.lqs != null ? <strong>{record.lqs}</strong> : <span className="no-data-text">—</span>}
                  </td>
                );
              })}
            </tr>
            <tr>
              <th>Listing 核验</th>
              {products.map(product => (
                <td key={product.asin}>
                  <a
                    className="listing-aplus-link"
                    href={`https://${market.domain}/dp/${product.asin}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开 Amazon 查看 A+ 模块
                  </a>
                  <small title={product.title}>{product.title}</small>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="listing-aplus-footnote">
        口径：A+ 来自 Sorftime product_detail.a_plus；EBC / 视频 / LQS 来自卖家精灵 asin_detail.badge。
        Premium A+ 具体模块需跳转 Listing 人工核对。
      </p>
    </section>
  );
}
