"use client";

import { StageOutputGapCard } from "../sync/stage-output-gap-card";
import { LISTING_IMAGES_SOURCE_LABEL, ListingImagesSection } from "./listing-images-section";
import { markets } from "../catalog/product-contracts";
import { SourceBadge } from "../../components/source-badge";
import { colors } from "../charts/chart-format";
import type { WorkspaceController } from "../workspace/use-workspace-controller";

type ListingTabProps = Pick<WorkspaceController, "stageOutputSnapshot" | "products" | "market" | "listingContentByAsin" | "imageRemarksByAsin" | "imageRemarkOutcomesByAsin">;

export function ListingTab({ stageOutputSnapshot, products, market, listingContentByAsin, imageRemarksByAsin, imageRemarkOutcomesByAsin }: ListingTabProps) {
  return <div className="page-content compare-page">
          <StageOutputGapCard snapshot={stageOutputSnapshot} stage="listing" />
          <StageOutputGapCard snapshot={stageOutputSnapshot} stage="image_remarks" />
          <section className="card page-intro">
            <div>
              <span className="status-chip">Listing 图册</span>
              <h2>纵向 ASIN、横向图片 1–9，同屏横向比较各竞品主图与辅图策略</h2>
              <p>布局对齐 Excel 竞品图册表：每行一个 ASIN，每列同一顺位素材；第 1 列为主图，其余为辅图；每张图下方灰色卡片为视觉结构摘要。</p>
            </div>
            <SourceBadge>{LISTING_IMAGES_SOURCE_LABEL}</SourceBadge>
          </section>
          <ListingImagesSection
            products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
            market={markets[market]}
            colors={colors}
            listingByAsin={listingContentByAsin}
            resolveImageRemark={(asin, slotIndex) => {
              const slots = imageRemarksByAsin[asin];
              return Array.isArray(slots) ? slots[slotIndex] as never ?? null : null;
            }}
            resolveImageOutcome={(asin, slotIndex) => {
              const slots = imageRemarkOutcomesByAsin[asin];
              const candidate = Array.isArray(slots) ? slots[slotIndex] : null;
              return candidate && typeof candidate === "object" && !Array.isArray(candidate)
                ? candidate as never
                : null;
            }}
          />
        </div>;
}
