"use client";

import { amazonMediaSrc } from "../lib/amazon-image";
import { sorftimeListingContentData } from "../sorftime-listing-content-data";
import { CatalogSourceStatus } from "../catalog-source-status";
import { type Product, type MarketCode, markets } from "../features/catalog/product-contracts";
import { colors } from "../features/charts/chart-format";

export function ProductHeader({ product, index, market }: { product: Product; index: number; market?: MarketCode }) {
  const marketInfo = markets[market ?? "US"];
  const image = amazonMediaSrc(sorftimeListingContentData[product.asin]?.mainImage || product.image);
  return <div className="compare-product-head">
    <span className="series-dot" style={{ background: colors[index] }}>{index + 1}</span>
    {image ? <img src={image} alt="" referrerPolicy="no-referrer" /> : <div className="image-placeholder">ASIN</div>}
    <div>
      <b>{product.brand}</b>
      <a
        className="asin-link"
        href={`https://${marketInfo.domain}/dp/${product.asin}`}
        target="_blank"
        rel="noreferrer"
        title={`打开 Amazon ${marketInfo.label}商品页`}
      >
        {product.asin}<span>↗</span>
      </a>
      <CatalogSourceStatus product={product} />
    </div>
  </div>;
}
