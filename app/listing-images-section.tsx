"use client";

import { useEffect, useState } from "react";
import { getListingImageRemark } from "./listing-image-remarks";
import {
  sorftimeListingContentData,
  sorftimeListingContentMeta,
} from "./sorftime-listing-content-data";

type ProductRef = {
  asin: string;
  brand: string;
  image: string;
};

type MarketInfo = {
  label: string;
  domain: string;
};

type HoverPreview = {
  url: string;
  label: string;
  width: number;
  left: number;
  top: number;
};

type PinnedPreview = {
  url: string;
  label: string;
  sourceKey: string;
  width: number;
};

const MAX_IMAGE_COLUMNS = 9;

function resolveGallery(asin: string, fallbackImage: string | null) {
  const record = sorftimeListingContentData[asin];
  if (record?.galleryImages?.length) return record.galleryImages;
  if (record?.mainImage) return [record.mainImage];
  if (fallbackImage) return [fallbackImage];
  return [];
}

export function ListingImagesSection({
  products,
  market,
  colors,
}: {
  products: ProductRef[];
  market: MarketInfo;
  colors: string[];
}) {
  const [hoverPreview, setHoverPreview] = useState<HoverPreview | null>(null);
  const [pinnedPreview, setPinnedPreview] = useState<PinnedPreview | null>(null);
  const imageColumnCount = Math.min(
    MAX_IMAGE_COLUMNS,
    Math.max(
      1,
      ...products.map(product => resolveGallery(product.asin, product.image).length),
    ),
  );
  const imageColumns = Array.from({ length: imageColumnCount }, (_, index) => index);

  useEffect(() => {
    if (!pinnedPreview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinnedPreview(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pinnedPreview]);

  const togglePinnedPreview = (url: string, label: string, sourceKey: string, thumbWidth: number) => {
    setHoverPreview(null);
    setPinnedPreview(current =>
      current?.sourceKey === sourceKey
        ? null
        : {
            url,
            label,
            sourceKey,
            width: Math.min(Math.round(thumbWidth * 4), Math.round(window.innerWidth * 0.88)),
          },
    );
  };

  return (
    <section className="card listing-images-card">
      <div className="section-head">
        <div>
          <h3>主辅图横向对比</h3>
          <p>
            纵向为竞品 ASIN，横向为图片 1–{imageColumnCount}（第 1 张为主图，其余为辅图）· 每张图下方为视觉结构摘要 · Sorftime · 同步至{" "}
            {sorftimeListingContentMeta.updatedAt}
          </p>
        </div>
        <span className="source-badge">Sorftime MCP</span>
      </div>
      <div className="matrix-wrap listing-images-matrix-wrap">
        <table className="compare-matrix listing-images-matrix">
          <thead>
            <tr>
              <th className="listing-images-asin-col">竞品 ASIN</th>
              {imageColumns.map(index => (
                <th key={index} className="listing-images-slot-col">
                  <span className="listing-images-slot-label">图片{index + 1}</span>
                  {index === 0 ? <small>主图</small> : <small>辅图</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {products.map((product, index) => {
              const record = sorftimeListingContentData[product.asin];
              const gallery = resolveGallery(product.asin, product.image);
              const listingUrl = `https://${market.domain}/dp/${product.asin}`;
              const ready = record?.status === "ready" && gallery.length > 0;

              return (
                <tr key={product.asin}>
                  <th className="listing-images-asin-col">
                    <div className="listing-images-asin-cell">
                      <span className="series-dot" style={{ background: colors[index % colors.length] }}>
                        {index + 1}
                      </span>
                      <div>
                        <b>{product.brand}</b>
                        <a className="asin-link" href={listingUrl} target="_blank" rel="noreferrer">
                          {product.asin}
                          <span>↗</span>
                        </a>
                        {ready ? (
                          <small className="listing-images-count">
                            图册 {record?.imageCount ?? gallery.length} 张
                          </small>
                        ) : (
                          <small className="listing-images-count muted">{sorftimeListingContentMeta.emptyMessage}</small>
                        )}
                      </div>
                    </div>
                  </th>
                  {imageColumns.map(slotIndex => {
                    const url = gallery[slotIndex] ?? null;
                    const label = `${product.brand} · 图片${slotIndex + 1}${slotIndex === 0 ? " · 主图" : " · 辅图"}`;
                    const sourceKey = `${product.asin}-${slotIndex}`;
                    const isPinnedSource = pinnedPreview?.sourceKey === sourceKey;
                    const imageRemark = getListingImageRemark(product.asin, slotIndex);
                    return (
                      <td
                        key={sourceKey}
                        className={`listing-images-slot-col${slotIndex === 0 ? " is-main-slot" : ""}`}
                      >
                        {!url ? (
                          <span className="listing-image-empty">—</span>
                        ) : (
                          <div className="listing-image-cell">
                            <button
                              type="button"
                              className={`listing-image-frame${isPinnedSource ? " is-pinned-source" : ""}`}
                              aria-label={`${label}，点击进一步放大`}
                              aria-pressed={isPinnedSource}
                              onMouseEnter={event => {
                                if (pinnedPreview) return;
                                const rect = event.currentTarget.getBoundingClientRect();
                                setHoverPreview({
                                  url,
                                  label,
                                  width: Math.round(rect.width * 2),
                                  left: rect.left + rect.width / 2,
                                  top: rect.top + rect.height / 2,
                                });
                              }}
                              onMouseLeave={() => {
                                if (!pinnedPreview) setHoverPreview(null);
                              }}
                              onClick={event => {
                                const rect = event.currentTarget.getBoundingClientRect();
                                togglePinnedPreview(url, label, sourceKey, rect.width);
                              }}
                            >
                              <img src={url} alt="" loading="lazy" />
                            </button>
                            {imageRemark ? (
                              <div className="listing-image-remark-block">
                                {imageRemark.image_types.length > 0 ? (
                                  <p className="listing-image-type-tags">
                                    {imageRemark.image_types.slice(0, 2).join(" · ")}
                                  </p>
                                ) : null}
                                <p className="listing-image-remark" title={imageRemark.remark}>
                                  {imageRemark.remark}
                                </p>
                              </div>
                            ) : (
                              <p className="listing-image-caption muted">
                                {slotIndex === 0 ? "主图 · 待分析" : "辅图 · 待分析"}
                              </p>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="listing-images-footnote">
        悬停约 2 倍预览 · 点击再放大至约 4 倍 · 点击空白处或按 Esc 关闭
      </p>

      {hoverPreview && !pinnedPreview ? (
        <div
          className="listing-image-hover-float"
          style={{
            width: hoverPreview.width,
            left: hoverPreview.left,
            top: hoverPreview.top,
          }}
        >
          <img src={hoverPreview.url} alt={hoverPreview.label} />
        </div>
      ) : null}

      {pinnedPreview ? (
        <div className="listing-image-focus-zoom" role="dialog" aria-modal="true" aria-label={pinnedPreview.label}>
          <button
            type="button"
            className="listing-image-focus-backdrop"
            aria-label="关闭放大预览"
            onClick={() => setPinnedPreview(null)}
          />
          <div className="listing-image-focus-panel" style={{ width: pinnedPreview.width }}>
            <div className="listing-image-focus-head">
              <b>{pinnedPreview.label}</b>
              <span>点击空白或 Esc 关闭</span>
            </div>
            <div className="listing-image-focus-body">
              <img src={pinnedPreview.url} alt={pinnedPreview.label} />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
