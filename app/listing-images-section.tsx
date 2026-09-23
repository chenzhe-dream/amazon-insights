"use client";

import { resolveRemarkForGalleryImage } from "./lib/listing-image-remark-resolution";

import { useEffect, useState } from "react";
import type { SyncJob } from "./lib/sync-progress-presentation";
import { ListingImageActions, type ListingImageAction } from "./listing-image-actions";
import { getListingImageRemark, listingImageRemarksMeta } from "./listing-image-remarks";
import { amazonMediaSrc } from "./lib/amazon-image";
import type { ImageRemarkOverlayEntry } from "../shared/image-remark-overlay";
import {
  sorftimeListingContentData,
  sorftimeListingContentMeta,
  type SorftimeListingContentRecord,
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

type GallerySource = "sorftime" | "sellerSpriteCatalog";

type ResolvedGallery = {
  urls: string[];
  source: GallerySource | null;
};

type ImageRemarkOutcomeStatus = "ready" | "upstream-empty" | "timeout" | "connector-failed";

type ImageRemarkOutcome = {
  status: ImageRemarkOutcomeStatus;
  reason: string;
};

const IMAGE_REMARK_OUTCOME_REASONS: Readonly<Record<ImageRemarkOutcomeStatus, string>> = {
  ready: "图片备注已就绪",
  "upstream-empty": "上游未返回可用图片备注",
  timeout: "图片分析超过 120 秒",
  "connector-failed": "图片分析连接器失败",
};

function getListingImageOutcome(asin: string, slotIndex: number): ImageRemarkOutcome | null {
  const status = (listingImageRemarksMeta as unknown as {
    imageOutcomesByAsin?: Readonly<Record<string, ReadonlyArray<{ status?: unknown } | null>>>;
  }).imageOutcomesByAsin?.[asin]?.[slotIndex]?.status;
  if (typeof status !== "string" || !(status in IMAGE_REMARK_OUTCOME_REASONS)) return null;
  const safeStatus = status as ImageRemarkOutcomeStatus;
  return { status: safeStatus, reason: IMAGE_REMARK_OUTCOME_REASONS[safeStatus] };
}

type ListingImagesSectionProps = {
  onImageAction?: (asin:string, action:ListingImageAction) => Promise<string | void>;
  imageActionJob?: SyncJob | null;
  imageActionPending?: boolean;
  products: ProductRef[];
  market: MarketInfo;
  colors: string[];
  listingByAsin?: Readonly<Record<string, SorftimeListingContentRecord>>;
  reportUnavailableReason?: string;
  resolveImageRemark?: typeof getListingImageRemark;
  resolveImageOutcome?: (asin: string, slotIndex: number) => ImageRemarkOutcome | null;
  resolveImageOverlay?: (asin: string, slotIndex: number) => ImageRemarkOverlayEntry | null;
};

export const LISTING_IMAGES_SOURCE_LABEL = "MCP 商品图";

function resolveGallery(
  asin: string,
  fallbackImage: string | null,
  listingByAsin: Readonly<Record<string, SorftimeListingContentRecord>>,
): ResolvedGallery {
  const record = listingByAsin[asin];
  if (record?.galleryImages?.length) return { urls: record.galleryImages, source: "sorftime" };
  if (record?.mainImage) return { urls: [record.mainImage], source: "sorftime" };
  if (fallbackImage) return { urls: [fallbackImage], source: "sellerSpriteCatalog" };
  return { urls: [], source: null };
}

function isVideoThumbnail(url: string) {
  return /PKplay-button/i.test(url);
}

export function ListingImagesSection({
  products,
  onImageAction,
  imageActionPending,
  imageActionJob,
  market,
  colors,
  listingByAsin = sorftimeListingContentData,
  reportUnavailableReason,
  resolveImageRemark = getListingImageRemark,
  resolveImageOutcome = getListingImageOutcome,
  resolveImageOverlay = () => null,
}: ListingImagesSectionProps) {
  const listingDates = [...new Set(Object.values(listingByAsin).map(record => record.fetchedAt).filter(Boolean))].sort();
  const listingSourceDate = listingDates.length ? listingDates.join("、") : sorftimeListingContentMeta.updatedAt;
  const [hoverPreview, setHoverPreview] = useState<HoverPreview | null>(null);
  const [pinnedPreview, setPinnedPreview] = useState<PinnedPreview | null>(null);
  const remarkForImage = (asin: string, slotIndex: number) => {
    const record = listingByAsin[asin] as (SorftimeListingContentRecord & {previousGalleryImages?: string[]}) | undefined;
    const url = record?.galleryImages?.[slotIndex];
    const current = url ? resolveRemarkForGalleryImage(url, slotIndex, record?.previousGalleryImages, index => resolveImageRemark(asin, index)) : resolveImageRemark(asin, slotIndex);
    if (current || !url) return current;
    const overlay = resolveImageOverlay(asin, slotIndex);
    return overlay?.asin === asin && overlay.index === slotIndex && overlay.imageUrl === url
      ? { remark: overlay.remark, image_types: overlay.imageTypes, confidence: overlay.confidence }
      : null;
  };
  const imageColumnCount = Math.min(
    MAX_IMAGE_COLUMNS,
    Math.max(
      1,
      ...products.map(product => resolveGallery(product.asin, product.image, listingByAsin).urls.length),
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

  const pendingRemarkCount = products.reduce((count, product) => {
    const gallery = resolveGallery(product.asin, product.image, listingByAsin);
    if (gallery.source !== "sorftime") return count;
    return (
      count +
      gallery.urls.filter((url, slotIndex) => Boolean(url) && !remarkForImage(product.asin, slotIndex)).length
    );
  }, 0);

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
            纵向为竞品 ASIN，横向为图片 1–{imageColumnCount}（第 1 张为主图，其余为辅图）· 每张图下方为视觉结构摘要 · Sorftime 图册优先，SellerSprite 商品图兜底
            {reportUnavailableReason ? ` · ${reportUnavailableReason}` : <> · Listing 数据采集于 {listingSourceDate}</>}
          </p>
        </div>
        <span className="source-badge">{LISTING_IMAGES_SOURCE_LABEL}</span>
      </div>
      {pendingRemarkCount > 0 ? (
        <p className="listing-images-pending-note">
          MCP 商品图已到位；{pendingRemarkCount} 张图缺少 AI 备注，具体原因见对应图片。
        </p>
      ) : null}
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
              const gallery = resolveGallery(product.asin, product.image, listingByAsin);
              const listingUrl = `https://${market.domain}/dp/${product.asin}`;
              const readyRemarkCount = gallery.urls.reduce(
                (count, _, slotIndex) => count + (remarkForImage(product.asin, slotIndex) ? 1 : 0),
                0,
              );
              const videoThumbnailCount = gallery.urls.filter(isVideoThumbnail).length;

              return (
                <tr key={product.asin}>
                  <th className="listing-images-asin-col">
                    <div className="listing-images-asin-cell">
                      <span className="series-dot" style={{ background: colors[index % colors.length] }}>
                        {index + 1}
                      </span>
                      {(() => {
                        const mainImage = amazonMediaSrc(
                          gallery.urls[0] || "",
                        );
                        return mainImage ? (
                          <img
                            className="listing-images-asin-thumb"
                            src={mainImage}
                            alt=""
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="image-placeholder listing-images-asin-thumb">ASIN</div>
                        );
                      })()}
                      <div>
                        <b>{product.brand}</b>
                        <a className="asin-link" href={listingUrl} target="_blank" rel="noreferrer">
                          {product.asin}
                          <span>↗</span>
                        </a>
                        {gallery.source === "sorftime" ? (
                          <small className="listing-images-count">
                            Sorftime MCP · Provider 返回 {gallery.urls.length} 张{videoThumbnailCount ? `（含 ${videoThumbnailCount} 个视频位缩略图）` : ""} · AI 备注 {readyRemarkCount}/{gallery.urls.length} 张
                            {readyRemarkCount < gallery.urls.length ? " · 分析待处理" : ""}
                          </small>
                        ) : gallery.source === "sellerSpriteCatalog" ? (
                          <small className="listing-images-count">
                            SellerSprite MCP · 商品图 {gallery.urls.length} 张
                          </small>
                        ) : (
                          <small className="listing-images-count muted">{reportUnavailableReason ?? "MCP 暂未返回商品图 · upstream-empty"}</small>
                        )}
                        <ListingImageActions asin={product.asin} onAction={onImageAction} job={imageActionJob} disabled={imageActionPending} />
                      </div>
                    </div>
                  </th>
                  {imageColumns.map(slotIndex => {
                    const url = gallery.urls[slotIndex] ?? null;
                    const imageKind = slotIndex === 0 ? "主图" : url && isVideoThumbnail(url) ? "视频位缩略图" : "辅图";
                    const label = `${product.brand} · 图片${slotIndex + 1} · ${imageKind}`;
                    const sourceKey = `${product.asin}-${slotIndex}`;
                    const isPinnedSource = pinnedPreview?.sourceKey === sourceKey;
                    const imageRemark = remarkForImage(product.asin, slotIndex);
                    const imageOverlay = imageRemark && !resolveRemarkForGalleryImage(url ?? "", slotIndex,
                      (listingByAsin[product.asin] as SorftimeListingContentRecord & {previousGalleryImages?: string[]})?.previousGalleryImages,
                      imageIndex => resolveImageRemark(product.asin, imageIndex))
                      ? resolveImageOverlay(product.asin, slotIndex) : null;
                    const imageOutcome = resolveImageOutcome(product.asin, slotIndex);
                    const imageOutcomeReason = imageOutcome
                      ? IMAGE_REMARK_OUTCOME_REASONS[imageOutcome.status]
                      : "尚无图片分析结果";
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
                              onMouseMove={event => {
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
                              <img src={amazonMediaSrc(url)} alt="" loading="lazy" referrerPolicy="no-referrer" />
                            </button>
                            {imageRemark ? (
                              <div className="listing-image-remark-block">
                                {imageOverlay?.imageUrl === url ? <p className="listing-image-caption muted">
                                  {imageOverlay.source.sourceKind === "supplemental-analysis" ? "补充分析" : "历史备注"} · {imageOverlay.source.capturedAt.slice(0, 10)}
                                  {imageOverlay.videoThumbnail ? " · 视频封面说明" : ""}
                                </p> : null}
                                {imageOutcome && imageOutcome.status !== "ready" ? <p className="listing-image-caption muted">
                                  {imageOverlay?.imageUrl === url ? "原任务图片分析未完成，已显示补充备注" : "本次重新分析失败，暂显示上次结果"} · {imageOutcomeReason}
                                </p> : null}
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
                                {imageKind} · {imageOutcomeReason}
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
          <img src={amazonMediaSrc(hoverPreview.url)} alt={hoverPreview.label} referrerPolicy="no-referrer" />
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
              <img src={amazonMediaSrc(pinnedPreview.url)} alt={pinnedPreview.label} referrerPolicy="no-referrer" />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
