"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { refreshedCatalog } from "./competitor-data";
import { sellerSpriteVariantData, sellerSpriteVariantMeta, type SellerSpriteVariant } from "./variant-data";
import { sorftimePriceStrategies, sorftimePriceStrategyMeta } from "./sorftime-price-strategy-data";
import { sorftimeFbaFeeData, sorftimeFbaFeeMeta } from "./sorftime-fba-fee-data";
import { sorftimeChildSales30d, sorftimeChildSalesMeta } from "./sorftime-child-sales-data";
import {
  sifListingTrafficOverview,
  sifListingTrafficMeta,
  childTrafficSegmentMeta,
  childTrafficSegments,
  sifAdChannelGlossary,
  sifAdChannelGlossaryList,
  type TrafficDistributionItem,
  type ChildTrafficVariant,
} from "./sif-listing-traffic-data";
import { sifMonthlyTrafficTrend, sifMonthlyTrafficMeta } from "./sif-monthly-traffic-trend-data";
import { rufusVocData, rufusVocDimensions, rufusVocMeta } from "./rufus-voc-data";
import { VocDimensionLabel } from "./voc-dimension-label";
import { buildVocDevelopmentSummary, hasVocDevelopmentData, vocDevBarPalette, vocDevelopmentSummaryMeta, vocInsightRingDimensions } from "./voc-development-summary";
import {
  formatReviewAnalysisItem,
  formatReviewSharePct,
  reviewAnalysisBarPalette,
  reviewAnalysisDimensions,
  sorftimeReviewAnalysisMeta,
  type SellerSpriteReviewAnalysisRecord,
} from "./seller-sprite-review-analysis";
import { sorftimeReviewAnalysisData, sorftimeReviewAnalysisMeta as sorftimeReviewDataMeta } from "./sorftime-review-analysis-data";
import { sorftimeSalesTrendData, sorftimeSalesTrendMeta } from "./sorftime-sales-trend-data";
import { sorftimeRatingData } from "./sorftime-rating-data";
import { ProductLaunchRecommendationSection } from "./product-launch-recommendation";
import { VocPositioningSection } from "./voc-positioning-section";
import { ProductDefinitionSection } from "./product-definition-section";
import { LaunchChecklistSection } from "./launch-checklist-section";
import { KeywordDemandSection } from "./keyword-demand-section";
import { SegmentStackBar, SegmentStackHoverPanel, segmentStackColors, type SegmentStackPart } from "./segment-stack-bar";
import { AlexaVocImportPanel } from "./alexa-voc-import-panel";
import { AsinSyncProgressSection, AsinSyncFunnel } from "./asin-sync-funnel";
import { KeywordFetchStatusSection } from "./keyword-fetch-status";
import { TrafficFetchStatusSection } from "./traffic-fetch-status";
import { CategoryNodeTrendSection } from "./category-node-trend-section";
import { ListingImagesSection } from "./listing-images-section";
import { ListingAplusSection } from "./listing-aplus-section";
import { ProjectLibraryPage, type AnalysisProject } from "./project-library-panel";
import { inferAmazonMajorCategory } from "./amazon-major-categories";
import { amazonMediaSrc } from "./lib/amazon-image";
import { localAgentFetch } from "./lib/local-agent-browser";
import {
  cancelVocRun,
  observeVocRun,
  retryVocStage,
  searchWithVocRunId,
  submitVocRun,
  vocRunIdFromSearch,
  waitForVocRun,
  VocRunClientError,
  type VocRunObservation,
} from "./lib/voc-run-browser";
import { projectWorkspacePath, workspaceHref } from "./lib/workspace-url";
import { sorftimeListingContentData } from "./sorftime-listing-content-data";
import { buildVariantAnalysisConclusion } from "./variant-analysis-conclusion";
import { buildTrafficAnalysisConclusion, type TrafficHealth } from "./traffic-analysis-conclusion";

type Keyword = { word: string; share: number; type: "自然" | "广告" };
type VariantDetail = { name: string; reviews: number | null; share: number | null; launch: string | null };
type Product = {
  asin: string;
  brand: string;
  image: string;
  title: string;
  price: number | null;
  sales: number | null;
  rating: number | null;
  reviews: number | null;
  rank: number | null;
  subRank: number | null;
  rankCategory: string;
  subRankCategory: string;
  buyBoxSeller: string;
  fulfillment: string;
  packageSize: string;
  packageWeight: string;
  specifications: string[];
  launch: string;
  format: string;
  variants: string;
  history: number[];
  prices: number[];
  ranks: number[];
  variantShare: number[];
  variantDetails: VariantDetail[];
  sellingPoints: string[];
  productFamily?: "scooter" | "lighting" | "generic";
  strengths: string[];
  weaknesses: string[];
  unmet: string[];
  scenarios: string[];
  audiences: string[];
  keywords: Keyword[];
  traffic: { natural: number; sponsored: number; recommendation: number };
  synced: boolean;
};

const colors = ["#2F80ED", "#7A67D8", "#29A7C7", "#F0A020", "#E65B6A", "#26A269", "#D45D9E", "#6C86B6", "#D26A3A", "#18A0A8"];
type ChartMetric = "history" | "prices" | "ranks" | "revenue";

function formatTrendMonthLabel(month: string, showYear = false) {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) return month;
  const monthNum = Number(match[2]);
  if (showYear) return `${match[1].slice(2)}/${monthNum}月`;
  return `${monthNum}月`;
}

function formatTrendMonthTitle(month: string) {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  return match ? `${match[1]}年${Number(match[2])}月` : month;
}

function sorftimeMetricKey(metric: ChartMetric): "volume" | "amount" | "price" | "rank" {
  if (metric === "history") return "volume";
  if (metric === "revenue") return "amount";
  if (metric === "prices") return "price";
  return "rank";
}

function isValidTrendValue(value: number | null | undefined) {
  return value != null && Number.isFinite(value) && value >= 0;
}

function collectChartMonthKeys(products: Product[], field: ReturnType<typeof sorftimeMetricKey>) {
  const months = new Set<string>();
  for (const product of products) {
    for (const point of sorftimeSalesTrendData[product.asin]?.[field] ?? []) {
      if (isValidTrendValue(point.value)) months.add(point.month);
    }
  }
  return [...months].sort().slice(-12);
}
const markets = {
  US: { label: "美国站", short: "US", option: "Amazon.com｜美国站", domain: "www.amazon.com" },
  UK: { label: "英国站", short: "UK", option: "Amazon.co.uk｜英国站", domain: "www.amazon.co.uk" },
  CA: { label: "加拿大站", short: "CA", option: "Amazon.ca｜加拿大站", domain: "www.amazon.ca" },
  DE: { label: "德国站", short: "DE", option: "Amazon.de｜德国站", domain: "www.amazon.de" },
} as const;
type MarketCode = keyof typeof markets;
type VariantSort = "sales" | "reviews" | "share" | "launch";
type TabId =
  | "overview"
  | "overview-images"
  | "overview-aplus"
  | "voc"
  | "launch"
  | "voc-positioning"
  | "definition"
  | "checklist"
  | "keywords"
  | "keyword-insight"
  | "traffic"
  | "projects"
  | "keyword-compare"
  | "traffic-promo"
  | "checklist-library";
type NavGroupId = "overview-group" | "voc-group" | "keywords-group" | "projects-group";

type NavLeaf = { id: TabId; label: string; sub: string };
type NavGroup = { id: NavGroupId; label: string; sub: string; children: NavLeaf[] };
type NavEntry = NavLeaf | NavGroup;

function isNavGroup(entry: NavEntry): entry is NavGroup {
  return "children" in entry;
}

function NavSubText({ text }: { text: string }) {
  const parts = String(text ?? "")
    .split(/\s*·\s*/)
    .filter(Boolean);
  if (parts.length <= 1) return <small>{text}</small>;
  return (
    <small className="nav-item-tags">
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>{part}</span>
      ))}
    </small>
  );
}

function tabFromParam(value: string | null, _sub: string | null = null): TabId {
  if (value === "traffic-conclusion") return "traffic";
  if (
    value === "overview-images" ||
    value === "overview-aplus" ||
    value === "voc" ||
    value === "launch" ||
    value === "voc-positioning" ||
    value === "definition" ||
    value === "checklist" ||
    value === "keywords" ||
    value === "keyword-insight" ||
    value === "traffic" ||
    value === "projects" ||
    value === "keyword-compare" ||
    value === "traffic-promo" ||
    value === "checklist-library"
  ) {
    return value;
  }
  return "overview";
}

function isOverviewFamilyTab(tabId: TabId) {
  return tabId === "overview" || tabId === "overview-images" || tabId === "overview-aplus";
}

function isVocFamilyTab(tabId: TabId) {
  return tabId === "voc" || tabId === "launch" || tabId === "voc-positioning";
}

function isKeywordFamilyTab(tabId: TabId) {
  return tabId === "keywords" || tabId === "keyword-insight";
}

function isProjectsFamilyTab(tabId: TabId) {
  return tabId === "projects" || tabId === "keyword-compare" || tabId === "traffic-promo" || tabId === "checklist-library";
}

function groupIdForTab(tabId: TabId): NavGroupId | null {
  if (isOverviewFamilyTab(tabId)) return "overview-group";
  if (isVocFamilyTab(tabId)) return "voc-group";
  if (isKeywordFamilyTab(tabId)) return "keywords-group";
  if (isProjectsFamilyTab(tabId)) return "projects-group";
  return null;
}

type NavTheme =
  | "traffic"
  | "convert"
  | "define"
  | "ads"
  | "search"
  | "insight"
  | "profit"
  | "stock"
  | "review"
  | "overview"
  | "params"
  | "gallery"
  | "layout"
  | "shield"
  | "bookmark";

const navThemeByDim: Record<string, NavTheme> = {
  "overview-group": "overview",
  overview: "params",
  "overview-images": "gallery",
  "overview-aplus": "layout",
  traffic: "traffic",
  "projects-group": "bookmark",
  projects: "stock",
  "keyword-compare": "search",
  "traffic-promo": "ads",
  "checklist-library": "shield",
  definition: "define",
  checklist: "shield",
  keywords: "search",
  "keyword-insight": "insight",
  "keywords-group": "search",
  launch: "profit",
  "voc-positioning": "convert",
  voc: "review",
  "voc-group": "review",
};

function NavThemeIcon({ dim }: { dim: string }) {
  const theme = navThemeByDim[dim] ?? "traffic";
  const glyph = {
    traffic: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M4.2 16.8h3.1V20H4.2zM10.45 12.2h3.1V20h-3.1zM16.7 7.2h3.1V20h-3.1z" fill="currentColor" opacity=".92"/>
        <path d="M4.4 11.2c2.2-3.4 4.5-4.2 6.8-2.2 2.1 1.8 3.7 1.9 5.7-.2l1.3-1.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M16.2 5.4h3.4v3.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    convert: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M3.5 5h2.2l1.4 9.2a1.6 1.6 0 0 0 1.6 1.35h8.4a1.6 1.6 0 0 0 1.55-1.2L20.5 8H7.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="10" cy="19.2" r="1.35" fill="currentColor"/>
        <circle cx="17.2" cy="19.2" r="1.35" fill="currentColor"/>
      </svg>
    ),
    define: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M4 9.2 12 4.6l8 4.6v7.6L12 21.4 4 16.8V9.2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="M12 4.6v8.2M12 12.8 20 9.2M12 12.8 4 9.2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="M6.4 10.6h3.4M6.4 12.4h4.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".9"/>
        <path d="M15.6 15.4 18.4 18.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
        <path d="m14.4 16.6 1.3-1.3 1.8 1.8-1.3 1.3-1.5-.2.2-1.6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
      </svg>
    ),
    ads: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M4.5 10.2v3.6c0 .9.7 1.6 1.6 1.6h2.2l5.4 3.4V5.2L8.3 8.6H6.1c-.9 0-1.6.7-1.6 1.6Z" fill="currentColor"/>
        <path d="M16.8 8.6c1.1.9 1.8 2.2 1.8 3.4s-.7 2.5-1.8 3.4M18.9 6.4c1.8 1.5 2.9 3.4 2.9 5.6s-1.1 4.1-2.9 5.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
      </svg>
    ),
    search: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="5.6" stroke="currentColor" strokeWidth="1.9"/>
        <path d="m14.8 14.8 4.4 4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"/>
        <path d="M8.2 10.5h4.6M10.5 8.2v4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      </svg>
    ),
    insight: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M12 3.6a5.4 5.4 0 0 0-3.2 9.7c.5.4.8 1 .8 1.6v.6h4.8v-.6c0-.6.3-1.2.8-1.6A5.4 5.4 0 0 0 12 3.6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
        <path d="M10 16.8h4M10.6 19.2h2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
        <path d="M12 7.2v2.4M10.2 9.4 12 11.2l1.8-1.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    profit: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <ellipse cx="12" cy="6.2" rx="6.2" ry="2.4" fill="currentColor"/>
        <path d="M5.8 6.2v3.6c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4V6.2" stroke="currentColor" strokeWidth="1.7"/>
        <path d="M5.8 9.8v3.6c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4V9.8" stroke="currentColor" strokeWidth="1.7"/>
        <path d="M5.8 13.4v3.6c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4v-3.6" stroke="currentColor" strokeWidth="1.7"/>
      </svg>
    ),
    stock: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M3.8 10.2 12 4.8l8.2 5.4V19a1.2 1.2 0 0 1-1.2 1.2H5a1.2 1.2 0 0 1-1.2-1.2v-8.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="M9 20.2V13h6v7.2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="M3.8 10.2h16.4" stroke="currentColor" strokeWidth="1.7"/>
      </svg>
    ),
    review: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M5 16.8 3.6 20.2 7.4 18.5A8.2 8.2 0 1 0 5 16.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="m12 8.2 1.05 2.15 2.35.3-1.75 1.6.5 2.3L12 13.4l-2.15 1.15.5-2.3-1.75-1.6 2.35-.3L12 8.2Z" fill="currentColor"/>
      </svg>
    ),
    overview: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <rect x="3.5" y="5.5" width="13" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.7"/>
        <rect x="7.5" y="9" width="13" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.7" fill="currentColor" fillOpacity=".08"/>
        <path d="M10.5 13.5h7M10.5 15.8h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      </svg>
    ),
    params: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <rect x="4" y="4.5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.7"/>
        <path d="M4 9.5h16M4 14h16M9.5 9.5v10" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
    gallery: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <rect x="3.5" y="5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.7"/>
        <path d="M3.5 13.5 7.2 10l2.4 2.1 2.6-3.2 4.3 4.6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <circle cx="8.2" cy="9" r="1.1" fill="currentColor"/>
        <rect x="11" y="8" width="9.5" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" opacity=".9"/>
      </svg>
    ),
    layout: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <rect x="4" y="3.5" width="16" height="17" rx="2" stroke="currentColor" strokeWidth="1.7"/>
        <rect x="6.5" y="6" width="11" height="4.5" rx="1" fill="currentColor" opacity=".32"/>
        <rect x="6.5" y="12" width="5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.4"/>
        <rect x="12.5" y="12" width="5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.4"/>
        <path d="M8 8.2h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    ),
    shield: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M12 3.4 5.2 6.1v5.8c0 4.1 2.9 7.9 6.8 9.1 3.9-1.2 6.8-5 6.8-9.1V6.1L12 3.4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="m9.2 12.1 1.8 1.8 3.8-3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    bookmark: (
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M7.2 4.4h9.6c.7 0 1.2.5 1.2 1.2v14.1l-6-3.3-6 3.3V5.6c0-.7.5-1.2 1.2-1.2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
        <path d="M9.4 9.2h5.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  }[theme];

  return (
    <span className="nav-icon-tile" data-theme={theme} aria-hidden="true">
      {glyph}
    </span>
  );
}

const MAX_ASIN_SLOTS = 10;

function buildInputSlots(asins: string[]) {
  const slots = Array.from({ length: MAX_ASIN_SLOTS }, () => "");
  asins.forEach((asin, index) => {
    if (index < slots.length) slots[index] = asin;
  });
  return slots;
}

function parseAsinsParam(raw: string | null): string[] | null {
  if (!raw?.trim()) return null;
  const values = raw
    .split(",")
    .map(value => value.trim().toUpperCase())
    .filter(Boolean);
  if (values.length < 3) return null;
  if (values.some(value => !/^[A-Z0-9]{10}$/.test(value))) return null;
  if (new Set(values).size !== values.length) return null;
  return values.slice(0, MAX_ASIN_SLOTS);
}

function resolveActiveAsins(raw: string | null) {
  return parseAsinsParam(raw) ?? [];
}

function sameAsinSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const other = new Set(right);
  return left.every(item => other.has(item));
}

function replaceAppUrl(params: URLSearchParams, basePath = "/") {
  if (typeof window === "undefined") return;
  const query = params.toString();
  const url = query ? `${basePath}?${query}` : basePath;
  window.history.replaceState(window.history.state, "", url);
}

function buildTabHref(tabId: TabId, current: URLSearchParams | { toString(): string }, basePath = "/") {
  const params = new URLSearchParams(current.toString());
  if (tabId === "overview") params.delete("tab");
  else params.set("tab", tabId);
  params.delete("sub");
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function buildProjectLoadHref(
  project: AnalysisProject,
  current: URLSearchParams | { toString(): string },
  tabId: TabId = "overview",
) {
  const params = new URLSearchParams(current.toString());
  if (tabId === "overview") params.delete("tab");
  else params.set("tab", tabId);
  params.delete("asins");
  params.delete("project");
  if (!project.slug) {
    params.set("asins", project.asins.join(","));
    params.set("project", project.id);
  }
  return workspaceHref(project.slug, params);
}

function setProjectParam(params: URLSearchParams, projectId: string | null) {
  if (projectId) params.set("project", projectId);
  else params.delete("project");
}

function placeholderProduct(asin: string): Product {
  return {
    asin, brand: "等待同步", image: "", title: "等待卖家精灵与 SIF MCP 返回商品数据",
    price: null, sales: null, rating: null, reviews: null, rank: null, subRank: null,
    rankCategory: "等待同步", subRankCategory: "等待同步", buyBoxSeller: "等待同步", fulfillment: "等待同步",
    packageSize: "—", packageWeight: "—", specifications: ["等待同步"],
    launch: "—", format: "—", variants: "—", history: [], prices: [], ranks: [], variantShare: [], variantDetails: [], sellingPoints: ["等待 Listing 内容同步后提炼"],
    strengths: ["数据同步后生成"], weaknesses: ["数据同步后生成"], unmet: ["数据同步后生成"],
    scenarios: ["待分析"], audiences: ["待分析"], keywords: [], traffic: { natural: 0, sponsored: 0, recommendation: 0 }, synced: false,
  };
}

function ReviewAnalysisMatrixSection({
  title,
  description,
  badge,
  data,
  dataMeta,
  configMeta,
  pendingSteps,
  products,
  market,
}: {
  title: string;
  description: string;
  badge: string;
  data: Record<string, SellerSpriteReviewAnalysisRecord & { mentionTopics?: number }>;
  dataMeta: { source: string; updatedAt: string; syncCommand?: string; mcpNote?: string };
  configMeta: typeof sorftimeReviewAnalysisMeta;
  pendingSteps: React.ReactNode;
  products: Product[];
  market: MarketCode;
}) {
  const hasReady = products.some(product => data[product.asin]?.status === "ready");

  return (
    <section className="card ss-review-matrix-card">
      <div className="section-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <SourceBadge>{badge}</SourceBadge>
      </div>
      {!hasReady ? (
        <div className="pending-box ss-review-pending">
          <strong>待同步评论分析数据</strong>
          <span>{dataMeta.mcpNote ?? configMeta.emptyMessage}</span>
          <span>{pendingSteps}</span>
        </div>
      ) : (
        <div className="matrix-wrap">
          <table className="compare-matrix voc-matrix ss-review-matrix">
            <thead>
              <tr>
                <th>分析维度</th>
                {products.map((product, index) => (
                  <th key={product.asin}>
                    <ProductHeader product={product} index={index} market={market} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reviewAnalysisDimensions.map(dimension => (
                <tr key={dimension.key}>
                  <th>
                    <span>{dimension.label}</span>
                    <small className="voc-status verified">{dimension.formatHint}</small>
                  </th>
                  {products.map(product => {
                    const analysis = data[product.asin];
                    const block = analysis?.blocks.find(item => item.key === dimension.key);
                    const rows = block?.rows ?? [];
                    const maxPct = Math.max(...rows.map(row => row.sharePct), 1);

                    if (analysis?.status !== "ready") {
                      return (
                        <td key={product.asin} className="bullet-cell ss-review-cell ss-review-cell-pending">
                          {analysis?.statusMessage ?? configMeta.emptyMessage}
                        </td>
                      );
                    }

                    return (
                      <td key={product.asin} className="bullet-cell ss-review-cell">
                        {rows.length ? (
                          <ul className="ss-review-theme-list">
                            {rows.map(row => (
                              <li key={`${product.asin}-${dimension.key}-${row.label}`}>
                                <div className="ss-review-theme-row">
                                  <b>{formatReviewAnalysisItem(row.label, row.sharePct)}</b>
                                  <div className="ss-review-theme-bar">
                                    <i>
                                      <b
                                        style={{
                                          width: `${Math.min(100, (row.sharePct / maxPct) * 100)}%`,
                                          background: reviewAnalysisBarPalette[dimension.key],
                                        }}
                                      />
                                    </i>
                                    <strong>{formatReviewSharePct(row.sharePct)}%</strong>
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="ss-review-empty">暂无匹配主题</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="voc-source-footnote">
        数据源：{dataMeta.source} · {configMeta.method} · {dataMeta.updatedAt}
      </p>
    </section>
  );
}

function VocSevenDimensionInsightSection({ products }: { products: Product[] }) {
  const summaries = useMemo(
    () => buildVocDevelopmentSummary(products.map(product => ({ asin: product.asin, brand: product.brand, productFamily: product.productFamily }))),
    [products]
  );
  const summaryMap = useMemo(() => new Map(summaries.map(item => [item.key, item])), [summaries]);

  return (
    <section className="card voc-seven-dim-card">
      <div className="section-head">
        <div>
          <h3>VOC 七维综合分析</h3>
          <p>
            融合 VOC 核心主题 + 智能评论分析 · 各维度内主题占比归一化至 100%
          </p>
        </div>
        <SourceBadge>{products.length} 竞品 · 双源融合</SourceBadge>
      </div>
      {!hasVocDevelopmentData(products) ? (
        <div className="pending-box">待 VOC 核心主题或智能评论分析就绪后，自动生成七维综合分析。</div>
      ) : (
        <>
          <div className="voc-seven-dim-grid">
            {vocInsightRingDimensions.map(dimension => {
              const summary = summaryMap.get(dimension.key);
              const themes = summary?.themes ?? [];
              const maxPct = Math.max(...themes.map(theme => theme.mentionPct), 1);

              return (
                <article
                  key={dimension.key}
                  className="voc-seven-dim-cell"
                  style={{ ["--segment-accent" as string]: vocDevBarPalette[dimension.key] }}
                >
                  <header>
                    <span className="voc-seven-dim-num">{dimension.num}</span>
                    <div>
                      <b>{summary?.label ?? dimension.key}</b>
                      <em>{dimension.en}</em>
                    </div>
                  </header>
                  {themes.length ? (
                    <ul className="voc-seven-dim-theme-list">
                      {themes.map(theme => (
                        <li key={`${dimension.key}-${theme.label}`}>
                          <div className="voc-seven-dim-theme-head">
                            <span>【{theme.label}】</span>
                            <strong>{theme.mentionPct >= 1 ? theme.mentionPct.toFixed(1) : theme.mentionPct.toFixed(2)}%</strong>
                          </div>
                          <div className="voc-seven-dim-theme-bar">
                            <i>
                              <b style={{ width: `${Math.min(100, (theme.mentionPct / maxPct) * 100)}%` }} />
                            </i>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="voc-seven-dim-empty">暂无归纳主题</p>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
      <p className="voc-source-footnote">
        汇总来源：{vocDevelopmentSummaryMeta.sources.join(" · ")} · 格式：{vocDevelopmentSummaryMeta.format}
      </p>
    </section>
  );
}

function SourceBadge({ children }: { children: React.ReactNode }) {
  return <span className="source-badge">{children}</span>;
}

function parseMotiveStarRating(segment: string) {
  if (!/[⭐★☆]/.test(segment)) return null;
  const filled = (segment.match(/⭐/g) ?? []).length || (segment.match(/★/g) ?? []).length;
  return filled > 0 ? Math.min(5, filled) : null;
}

function renderVocMatrixItem(item: string, dimensionKey: string) {
  if (dimensionKey !== "motives" || !item.includes("｜")) return item;
  const parts = item.split("｜");
  if (parts.length < 3) return item;
  const starRating = parseMotiveStarRating(parts[1]);
  if (starRating == null) return item;
  return (
    <>
      {parts[0]}｜<AmazonStarRating rating={starRating} compact />｜{parts.slice(2).join("｜")}
    </>
  );
}

function AmazonStarRating({ rating, compact = false }: { rating: number; compact?: boolean }) {
  const clamped = Math.max(0, Math.min(5, rating));
  return (
    <div
      className={compact ? "amazon-star-rating amazon-star-rating-compact" : "amazon-star-rating"}
      aria-label={`${clamped.toFixed(1)} 星，满分 5 星`}
    >
      <span className="amazon-star-rating-stars" aria-hidden="true">
        <span className="amazon-star-rating-base">★★★★★</span>
        <span className="amazon-star-rating-fill" style={{ width: `${(clamped / 5) * 100}%` }}>★★★★★</span>
      </span>
      {!compact ? <span className="amazon-star-rating-value">{clamped.toFixed(1)}</span> : null}
    </div>
  );
}

function RatingCell({ rating, reviews }: { rating: number; reviews: number | null }) {
  return (
    <div className="rating-cell">
      <AmazonStarRating rating={rating} />
      {reviews !== null && <small>{reviews.toLocaleString()} 条</small>}
    </div>
  );
}

function TrafficDistributionBars({ items, palette, maxItems, glossary }: {
  items: TrafficDistributionItem[];
  palette: string[];
  maxItems?: number;
  glossary?: Record<string, { en: string; meaning: string }>;
}) {
  const visible = maxItems ? items.slice(0, maxItems) : items;
  if (!visible.length) return <div className="traffic-dist-empty"><strong>—</strong><span>{sifListingTrafficMeta.emptyMessage}</span></div>;
  return (
    <div className="traffic-dist-bars">
      {visible.map((item, index) => {
        const tip = glossary?.[item.label];
        const title = tip
          ? `${item.label} · ${tip.en}\n${tip.meaning}\n${item.score.toLocaleString()} · ${item.ratio}%`
          : `${item.label} · ${item.score.toLocaleString()} · ${item.ratio}%`;
        return (
          <div key={item.label} title={title}>
            <span title={title}>{item.label}</span>
            <i><b style={{ width: `${Math.min(100, item.ratio)}%`, background: palette[index % palette.length] }} /></i>
            <strong>{item.score.toLocaleString()}</strong>
            <em>{item.ratio}%</em>
          </div>
        );
      })}
    </div>
  );
}

function ChildTrafficStructurePanel({ variants }: { variants: ChildTrafficVariant[] }) {
  const previewCount = 3;
  const [expanded, setExpanded] = useState(false);
  const ranked = [...variants].sort((a, b) => b.totalScore - a.totalScore || b.sharePct - a.sharePct);
  if (!ranked.length) {
    return <div className="traffic-dist-empty"><strong>—</strong><span>{sifListingTrafficMeta.emptyMessage}</span></div>;
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
                <img src={amazonMediaSrc(child.image)} alt="" referrerPolicy="no-referrer" />
                <div>
                  <b>#{index + 1} · {child.label}</b>
                  <small>{child.asin}</small>
                </div>
                <em>{child.sharePct}%</em>
              </div>
              <div className="child-traffic-bar-wrap" style={{ width: `${Math.max(18, (child.totalScore / maxScore) * 100)}%` }}>
                <SegmentStackBar segments={segments} hideSegmentTitle={false} />
                <strong>{child.totalScore.toLocaleString()}</strong>
              </div>
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 ? (
        <button type="button" className="variant-detail-toggle" onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起子体" : `展开其余 ${hiddenCount} 个子体`}
        </button>
      ) : null}
    </div>
  );
}

const childSalesBarPalette = ["#2F80ED", "#1AA8A1", "#7A67D8", "#E8912D", "#E65B6A", "#26A269"];

function ChildSalesBars({ items }: { items: Array<{ asin: string; variant: string; sales: number; observedAt: string }> }) {
  if (!items.length) {
    return <span className="no-data-text child-sales-empty" title={`${sorftimeChildSalesMeta.source}；核查时间 ${sorftimeChildSalesMeta.checkedAt}`}>{sorftimeChildSalesMeta.emptyMessage}</span>;
  }
  const max = Math.max(...items.map(item => item.sales));
  return <div className="child-sales-bars">{items.map((item, index) => <div key={item.asin} title={`${item.asin} · 数据核查 ${item.observedAt}`}><span>{item.variant}</span><i><b style={{ width: `${Math.max(10, (item.sales / max) * 100)}%`, background: childSalesBarPalette[index % childSalesBarPalette.length] }} /></i><strong>{item.sales.toLocaleString()}+</strong></div>)}</div>;
}

function SalesTrendSparkline({ asin, sales30d, color }: { asin: string; sales30d: number | null; color: string }) {
  const record = sorftimeSalesTrendData[asin];
  const [open, setOpen] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const volumeColor = "#5DAFE8";
  const amountColor = "#7A67D8";
  const volumeSeries = record?.status === "ready" ? record.volume : [];
  const amountByMonth = new Map((record?.amount ?? []).map(point => [point.month, point.value]));
  const merged = volumeSeries.map(point => ({
    month: point.month,
    volume: point.value,
    amount: amountByMonth.get(point.month) ?? 0,
  }));
  const sparkData = merged.slice(-18).map(point => point.volume);
  const latestVolume = [...volumeSeries]
    .filter(point => Number(point.value) > 0)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .at(-1)?.value;
  const displaySales = latestVolume ?? sales30d;

  if (!sparkData.length) {
    return <strong>{displaySales === null || displaySales === undefined ? "—" : `${Number(displaySales).toLocaleString()}+`}</strong>;
  }

  const sparkW = 56;
  const sparkH = 22;
  const sparkPad = 2;
  const sparkMin = Math.min(...sparkData);
  const sparkMax = Math.max(...sparkData);
  const sparkPoints = sparkData
    .map((value, index) => {
      const x = sparkPad + (index * (sparkW - sparkPad * 2)) / Math.max(sparkData.length - 1, 1);
      const y = sparkPad + (1 - (value - sparkMin) / (sparkMax - sparkMin || 1)) * (sparkH - sparkPad * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const width = 500;
  const height = 220;
  const padLeft = 46;
  const padRight = 54;
  const padY = 28;
  const chartWidth = width - padLeft - padRight;
  const volMax = Math.max(...merged.map(point => point.volume), 1);
  const amtMax = Math.max(...merged.map(point => point.amount), 1);
  const count = merged.length;
  const barWidth = Math.min(12, (chartWidth / Math.max(count, 1)) * 0.55);

  const xAt = (index: number) => padLeft + (index * chartWidth) / Math.max(count - 1, 1);
  const yVol = (value: number) => padY + (1 - value / volMax) * (height - padY * 2);
  const yAmt = (value: number) => padY + (1 - value / amtMax) * (height - padY * 2);
  const formatVolume = (value: number) => Math.round(value).toLocaleString();
  const formatAmount = (value: number) =>
    `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const axisMonths = merged.filter((_, index) => index % Math.ceil(merged.length / 8) === 0 || index === merged.length - 1);
  const volTicks = [0, 0.25, 0.5, 0.75, 1].map(ratio => Math.round(volMax * ratio));
  const amtTicks = [0, 0.25, 0.5, 0.75, 1].map(ratio => Math.round(amtMax * ratio));

  return (
    <div
      className="sales-trend-cell"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        setOpen(false);
        setHoverIndex(null);
      }}
    >
      <div className="sales-trend-value">
        <strong>{displaySales === null || displaySales === undefined ? "—" : `${Number(displaySales).toLocaleString()}+`}</strong>
        <span className="sales-trend-spark" aria-label="悬停查看历史销量趋势">
          <svg viewBox={`0 0 ${sparkW} ${sparkH}`} width={sparkW} height={sparkH} role="img">
            <polyline points={sparkPoints} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
      {open && merged.length > 0 && (
        <div className="sales-trend-popover">
          <div className="sales-trend-popover-head">
            <span className="sales-trend-popover-title">
              <i />销量趋势
            </span>
          </div>
          <div className="sales-trend-popover-legend">
            <span>
              <i className="sales-trend-legend-bar" style={{ background: volumeColor }} />
              当月销量
            </span>
            <span>
              <i className="sales-trend-legend-line" style={{ borderColor: amountColor }} />
              月销售额
            </span>
          </div>
          <div className="sales-trend-popover-chart">
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="历史销量与销售额趋势">
              {[0, 1, 2, 3].map(index => {
                const y = padY + (index * (height - padY * 2)) / 3;
                return <line key={index} x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke="#EEF2F6" />;
              })}
              {volTicks.slice(1).map(tick => (
                <text key={`vol-${tick}`} x={padLeft - 6} y={yVol(tick) + 3} textAnchor="end" className="sales-trend-axis-label sales-trend-axis-label-left">
                  {tick >= 1000 ? `${Math.round(tick / 1000)}k` : tick}
                </text>
              ))}
              {amtTicks.slice(1).map(tick => (
                <text key={`amt-${tick}`} x={width - padRight + 6} y={yAmt(tick) + 3} textAnchor="start" className="sales-trend-axis-label sales-trend-axis-label-right">
                  {tick >= 1000 ? `${Math.round(tick / 1000)}k` : tick}
                </text>
              ))}
              {merged.map((point, index) => {
                const x = xAt(index);
                const barHeight = height - padY - yVol(point.volume);
                return (
                  <rect
                    key={`bar-${point.month}`}
                    x={x - barWidth / 2}
                    y={yVol(point.volume)}
                    width={barWidth}
                    height={Math.max(1, barHeight)}
                    fill={volumeColor}
                    opacity={hoverIndex === index ? 0.95 : 0.72}
                    rx="1.5"
                  />
                );
              })}
              <polyline
                points={merged
                  .map((point, index) => {
                    const pointCoord = { x: xAt(index), y: yAmt(point.amount) };
                    return `${pointCoord.x},${pointCoord.y}`;
                  })
                  .join(" ")}
                fill="none"
                stroke={amountColor}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {merged.map((point, index) => (
                <circle
                  key={`line-${point.month}`}
                  cx={xAt(index)}
                  cy={yAmt(point.amount)}
                  r={hoverIndex === index ? 4 : 3}
                  fill="#fff"
                  stroke={amountColor}
                  strokeWidth="2"
                />
              ))}
              {hoverIndex != null && (
                <line
                  x1={xAt(hoverIndex)}
                  x2={xAt(hoverIndex)}
                  y1={padY}
                  y2={height - padY}
                  stroke="#C5CFDB"
                  strokeDasharray="4 4"
                />
              )}
              {merged.map((_, index) => {
                const x = xAt(index);
                const step = chartWidth / Math.max(count - 1, 1);
                const left = Math.max(0, index === 0 ? 0 : x - step / 2);
                const right = Math.min(width, index === count - 1 ? width : x + step / 2);
                return (
                  <rect
                    key={`hover-${index}`}
                    x={left}
                    y="0"
                    width={right - left}
                    height={height}
                    fill="transparent"
                    onMouseMove={() => setHoverIndex(index)}
                  />
                );
              })}
            </svg>
            {hoverIndex != null && (
              <div className="sales-trend-hover-tip" style={{ left: `${(xAt(hoverIndex) / width) * 100}%` }}>
                <b>{merged[hoverIndex].month}</b>
                <div className="sales-trend-hover-row">
                  <span>
                    <i style={{ background: volumeColor }} />
                    当月销量
                  </span>
                  <strong>{formatVolume(merged[hoverIndex].volume)}</strong>
                </div>
                <div className="sales-trend-hover-row">
                  <span>
                    <i style={{ background: amountColor }} />
                    月销售额
                  </span>
                  <strong>{formatAmount(merged[hoverIndex].amount)}</strong>
                </div>
              </div>
            )}
          </div>
          <div className="sales-trend-month-axis">
            {axisMonths.map(point => (
              <span key={point.month}>{point.month}</span>
            ))}
          </div>
          <p className="sales-trend-popover-foot">
            {sorftimeSalesTrendMeta.source} · {record?.fetchedAt}
          </p>
        </div>
      )}
    </div>
  );
}

type ChartHover = {
  x: number;
  month: string;
  entries: Array<{ asin: string; brand: string; color: string; value: string }>;
};

function ComparisonChart({ products, metric, inverse = false }: { products: Product[]; metric: ChartMetric; inverse?: boolean }) {
  const [hover, setHover] = useState<ChartHover | null>(null);
  const width = 900;
  const plotHeight = 210;
  const axisHeight = 20;
  const height = plotHeight + axisHeight;
  const padX = 32;
  const padY = 22;
  const field = sorftimeMetricKey(metric);
  const monthKeys = collectChartMonthKeys(products, field);
  const seriesByProduct = products.map((product, index) => {
    const map = new Map(
      (sorftimeSalesTrendData[product.asin]?.[field] ?? [])
        .filter(point => isValidTrendValue(point.value))
        .map(point => [point.month, point.value]),
    );
    return {
      product,
      color: colors[index],
      series: monthKeys.map(month => map.get(month) ?? null),
    };
  });
  const all = seriesByProduct.flatMap(({ series }) => series.filter((value): value is number => value != null));
  if (!monthKeys.length || !all.length) {
    return <div className="empty-chart">等待 Sorftime 同步 · {sorftimeSalesTrendMeta.syncCommand}</div>;
  }
  const maxCount = monthKeys.length;
  const showYearOnAxis = new Set(monthKeys.map(month => month.slice(0, 4))).size > 1;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const chartWidth = width - padX * 2;
  const plotBottom = plotHeight - padY;
  const xAt = (index: number) => padX + index * chartWidth / Math.max(maxCount - 1, 1);
  const point = (value: number, i: number) => {
    const x = xAt(i);
    const normalized = (value - min) / (max - min || 1);
    const y = padY + (inverse ? normalized : 1 - normalized) * (plotBottom - padY);
    return { x, y };
  };
  const formatValue = (value: number) =>
    metric === "prices"
      ? `$${value.toFixed(2)}`
      : metric === "ranks"
        ? `#${Math.round(value).toLocaleString()}`
        : metric === "revenue"
          ? `$${Math.round(value).toLocaleString()}`
          : `${Math.round(value).toLocaleString()} 件`;
  return (
    <div className="comparison-chart">
      <div className="chart-stage">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="多竞品趋势对比图" onMouseLeave={() => setHover(null)}>
          {[0, 1, 2, 3].map(i => (
            <line key={i} x1={padX} x2={width - padX} y1={padY + i * 46} y2={padY + i * 46} stroke="#E7ECF2" strokeDasharray="4 5" />
          ))}
          {seriesByProduct.map(({ product: p, color, series }) => {
            const defined = series
              .map((value, index) => (value == null ? null : { value, index }))
              .filter((item): item is { value: number; index: number } => item != null);
            if (!defined.length) return null;
            return (
              <g key={p.asin}>
                <polyline
                  points={defined.map(({ value, index }) => {
                    const pt = point(value, index);
                    return `${pt.x},${pt.y}`;
                  }).join(" ")}
                  fill="none"
                  stroke={color}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {defined.map(({ value, index }) => {
                  const pt = point(value, index);
                  return (
                    <circle
                      key={`${p.asin}-${index}`}
                      className="chart-point"
                      cx={pt.x}
                      cy={pt.y}
                      r="3.5"
                      fill={color}
                      stroke="#fff"
                      strokeWidth="2"
                      pointerEvents="none"
                    >
                      <title>{p.brand} · {formatTrendMonthTitle(monthKeys[index])} · {formatValue(value)}</title>
                    </circle>
                  );
                })}
              </g>
            );
          })}
          {hover && (
            <line className="chart-hover-line" x1={hover.x} x2={hover.x} y1={padY} y2={plotBottom} stroke="#8393A8" strokeWidth="1" strokeDasharray="4 4" />
          )}
          {Array.from({ length: maxCount }).map((_, index) => {
            const x = xAt(index);
            const step = chartWidth / Math.max(maxCount - 1, 1);
            const left = Math.max(0, index === 0 ? 0 : x - step / 2);
            const right = Math.min(width, index === maxCount - 1 ? width : x + step / 2);
            const entries = seriesByProduct.flatMap(({ product, color, series }) =>
              series[index] == null
                ? []
                : [{ asin: product.asin, brand: product.brand, color, value: formatValue(series[index] as number) }],
            );
            return (
              <rect
                key={index}
                className="chart-hover-zone"
                x={left}
                y="0"
                width={right - left}
                height={plotHeight}
                fill="transparent"
                onMouseMove={() => setHover({ x, month: formatTrendMonthTitle(monthKeys[index]), entries })}
              />
            );
          })}
          {monthKeys.map((month, index) => (
            <text
              key={`axis-${month}`}
              x={xAt(index)}
              y={height - 5}
              textAnchor="middle"
              className="comparison-chart-axis-label"
            >
              {formatTrendMonthLabel(month, showYearOnAxis)}
            </text>
          ))}
        </svg>
        {hover && (
          <div
            className="chart-tooltip chart-tooltip-group"
            style={{
              left: `${(hover.x / width) * 100}%`,
              top: "12px",
              transform: hover.x / width < 0.2 ? "translateX(0)" : hover.x / width > 0.8 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            <b className="chart-tooltip-title">{hover.month}</b>
            {hover.entries.map(entry => (
              <div className="chart-tooltip-row" key={entry.asin}>
                <span>
                  <i style={{ background: entry.color }} />
                  {entry.brand}
                </span>
                <strong>{entry.value}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type MonthlyTrafficHover = {
  x: number;
  month: string;
  brand: string;
  asin: string;
  natural: number;
  ad: number;
  total: number;
  brandColor: string;
};

function MonthlyTrafficStackChart({ products }: { products: Product[] }) {
  const [hover, setHover] = useState<MonthlyTrafficHover | null>(null);
  const width = 980;
  const height = 300;
  const padL = 52;
  const padR = 18;
  const padT = 18;
  const padB = 44;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const monthLabels = sifMonthlyTrafficMeta.months;
  const brandCounts = products.reduce<Record<string, number>>((acc, product) => {
    acc[product.brand] = (acc[product.brand] ?? 0) + 1;
    return acc;
  }, {});
  const series = products
    .map((product, index) => ({
      product,
      color: colors[index],
      label: brandCounts[product.brand] > 1 ? `${product.brand} · ${product.asin.slice(-4)}` : product.brand,
      points: sifMonthlyTrafficTrend[product.asin]?.points ?? [],
    }))
    .filter(item => item.points.length);

  if (!series.length) return <div className="empty-chart">等待 SIF 月流量结构数据</div>;

  const monthCount = monthLabels.length;
  const brandCount = series.length;
  const maxTotal = Math.max(...series.flatMap(item => item.points.map(point => point.total)), 1);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(ratio => Math.round(maxTotal * ratio));
  const groupGap = plotW / brandCount;
  const barGap = 2;
  const barWidth = Math.min(16, Math.max(8, (groupGap * 0.78 - barGap * (monthCount - 1)) / monthCount));
  const clusterWidth = monthCount * barWidth + (monthCount - 1) * barGap;
  const yFor = (value: number) => padT + plotH * (1 - value / maxTotal);

  return (
    <div className="comparison-chart monthly-traffic-stack-chart">
      <div className="chart-stage">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="按品牌近6个月自然广告堆叠柱图" onMouseLeave={() => setHover(null)}>
          {yTicks.map((tick, index) => {
            const y = yFor(tick);
            return (
              <g key={tick}>
                <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="#E7ECF2" strokeDasharray="4 5" />
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
                  const monthLabel = monthLabels[monthIndex] ?? point.label;
                  const x = clusterLeft + monthIndex * (barWidth + barGap);
                  const naturalH = (point.natural / maxTotal) * plotH;
                  const adH = (point.ad / maxTotal) * plotH;
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
                      <rect
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
                      <rect x={x} y={adY} width={barWidth} height={stackH} fill="transparent" />
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
        {hover && (
          <div
            className="chart-tooltip chart-tooltip-group monthly-traffic-tooltip"
            style={{
              left: `${(hover.x / width) * 100}%`,
              top: "12px",
              transform: hover.x / width < 0.2 ? "translateX(0)" : hover.x / width > 0.8 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            <b className="chart-tooltip-title">{hover.brand} · {hover.month}</b>
            <div className="chart-tooltip-row"><span><i style={{ background: sifMonthlyTrafficMeta.naturalColor }} />自然流量</span><strong>{hover.natural.toLocaleString()}</strong></div>
            <div className="chart-tooltip-row"><span><i style={{ background: sifMonthlyTrafficMeta.adColor }} />广告流量</span><strong>{hover.ad.toLocaleString()}</strong></div>
            <div className="chart-tooltip-row"><span><i style={{ background: hover.brandColor }} />合计</span><strong>{hover.total.toLocaleString()}</strong></div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProductHeader({ product, index, market }: { product: Product; index: number; market?: MarketCode }) {
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
      {!product.synced && <em>等待同步</em>}
    </div>
  </div>;
}

function sortedVariants(items: SellerSpriteVariant[], sort: VariantSort) {
  const value = (item: SellerSpriteVariant) => sort === "sales" ? item.childSales : sort === "reviews" ? item.reviews : sort === "share" ? item.reviewShare : item.launch ? Date.parse(item.launch) : null;
  return [...items].sort((a,b) => (value(b) ?? -1) - (value(a) ?? -1) || (b.reviews ?? -1) - (a.reviews ?? -1));
}

function variantLabel(attribute: string) {
  return attribute.replace(/^颜色：/, "");
}

function buildReviewShareSegments(items: SellerSpriteVariant[]): SegmentStackPart[] {
  return [...items]
    .filter(item => item.reviewShare !== null && item.reviewShare > 0)
    .sort((a, b) => (b.reviewShare ?? 0) - (a.reviewShare ?? 0))
    .map(item => ({ value: item.reviewShare ?? 0, label: variantLabel(item.attribute) }));
}

function VariantShareStructure({ items }: { items: SellerSpriteVariant[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const segments = buildReviewShareSegments(items);
  return (
    <div className="variant-metric-bars">
      <div className="variant-bar-block">
        <div className="variant-bar-head"><b>评论占比结构</b><span>各变体评论占比 · 悬停查看明细</span></div>
        <div
          className="variant-share-stack-wrap"
          onMouseLeave={() => setHovered(null)}
        >
          <SegmentStackBar segments={segments} absolute activeLabel={hovered} onSegmentHover={setHovered} />
          <SegmentStackHoverPanel segments={segments} activeLabel={hovered} onHover={setHovered} />
        </div>
      </div>
    </div>
  );
}

function variationTheme(product: Product) {
  const source = [product.format, ...(sellerSpriteVariantData[product.asin]??[]).map(item=>item.attribute), ...product.variantDetails.map(item=>item.name)].join(" ");
  const themes: string[] = [];
  if (/color|颜色/i.test(source)) themes.push("颜色");
  if (/size|尺寸/i.test(source)) themes.push("尺寸");
  if (/style|款式/i.test(source)) themes.push("款式");
  if (/configuration|配置/i.test(source)) themes.push("配置");
  return themes.join("、") || "暂无数据";
}

function VariantDetailTable({ items, currentAsin }: { items: SellerSpriteVariant[]; currentAsin: string }) {
  const previewCount = 3;
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items : items.slice(0, previewCount);
  const hiddenCount = Math.max(0, items.length - previewCount);

  return (
    <div className="variant-detail-table">
      <div className="variant-detail-head">
        <span>变体 / ASIN</span>
        <span>评论数</span>
        <span>评论占比</span>
        <span>子销量</span>
        <span>上架时间</span>
      </div>
      {visibleItems.map((variant, index) => (
        <div className="variant-detail-row" key={variant.asin}>
          <span>
            {variant.image ? <img src={amazonMediaSrc(variant.image)} alt="" referrerPolicy="no-referrer" /> : <i style={{ background: segmentStackColors[index % 4] }} />}
            <span>
              {variant.attribute}
              <small>{variant.asin}</small>
            </span>
            {variant.asin === currentAsin && <em>当前</em>}
          </span>
          <b>{variant.reviews === null ? "暂无数据" : variant.reviews.toLocaleString()}</b>
          <strong>{variant.reviewShare === null ? "暂无数据" : `${variant.reviewShare}%`}</strong>
          <span className="variant-sales">
            {variant.childSales === null ? (
              "暂无数据"
            ) : (
              <>
                <b>{variant.childSales.toLocaleString()}</b>
                <small>{variant.salesMonth}</small>
              </>
            )}
          </span>
          <time>{variant.launch ?? "暂无数据"}</time>
        </div>
      ))}
      {hiddenCount > 0 ? (
        <button type="button" className="variant-detail-toggle" onClick={() => setExpanded(value => !value)}>
          {expanded ? "收起变体" : `展开其余 ${hiddenCount} 个变体`}
        </button>
      ) : null}
    </div>
  );
}

function VariantSummary({ items }: { items: SellerSpriteVariant[] }) {
  const withSales = items.filter(item => item.childSales !== null).sort((a,b)=>(b.childSales ?? 0)-(a.childSales ?? 0));
  const withReviews = items.filter(item => item.reviews !== null).sort((a,b)=>(b.reviews ?? 0)-(a.reviews ?? 0));
  const missing = items.filter(item => item.childSales === null && item.reviews === null).length;
  if (!withSales.length && !withReviews.length) return <p className="variant-summary empty">卖家精灵本次未返回可核验的子体评论与销量，暂不判断畅销变体。</p>;
  const salesNames = withSales.slice(0,2).map(item=>item.attribute.replace("颜色：","")).join("、");
  const reviewNames = withReviews.slice(0,2).map(item=>item.attribute.replace("颜色：","")).join("、");
  return <p className="variant-summary"><b>单品结论：</b>{salesNames ? `${salesNames} 的子体销量领先；` : ""}评论沉淀以 {reviewNames} 为主。{missing>0&&`另有 ${missing} 个变体缺少可核验数据，未纳入判断。`}</p>;
}

function BackToTopButton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 420);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      className={`back-to-top-btn${visible ? " visible" : ""}`}
      aria-label="返回顶部"
      title="返回顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" aria-hidden="true">
        <path d="M12 6.5v11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        <path d="m7.8 11 4.2-4.3L16.2 11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>顶部</span>
    </button>
  );
}

function healthClass(health: TrafficHealth) {
  if (health === "健康") return "health-good";
  if (health === "基本健康") return "health-ok";
  if (health === "需观察") return "health-watch";
  return "health-risk";
}

function TrafficAnalysisConclusionSection({ products, market }: { products: Product[]; market: MarketCode }) {
  const conclusion = useMemo(
    () => buildTrafficAnalysisConclusion(products.map(p => ({ asin: p.asin, brand: p.brand }))),
    [products],
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

function VariantPortfolioSummary({ products }: { products: Product[] }) {
  const conclusion = buildVariantAnalysisConclusion(products);
  const roleLabel = { must: "必上", add: "建议加", watch: "观察" } as const;

  return (
    <div className="variant-portfolio-summary variant-analysis-conclusion">
      <div className="variant-conclusion-main">
        <span className="status-chip">{conclusion.title}</span>
        <h4>{conclusion.headline}</h4>
        <p>{conclusion.methodNote}</p>
        <ul className="variant-conclusion-recs">
          {conclusion.addRecommendations.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <small className="variant-conclusion-evidence">{conclusion.evidenceNote}</small>
      </div>

      <div className="variant-conclusion-panels">
        <div className="variant-conclusion-panel">
          <div className="variant-conclusion-panel-head">
            <b>评论数占比 TOP5</b>
            <span>全竞品子体聚合</span>
          </div>
          <div className="variant-leader-list">
            {conclusion.topReviewShare.map(item => (
              <span key={`review-${item.name}`}>
                <b>{item.rank}</b>
                <em>{item.name}</em>
                <strong>{item.reviewSharePct}%</strong>
                <small>
                  评论 {item.reviews.toLocaleString()} · {item.linkCount} 链接
                </small>
              </span>
            ))}
          </div>
        </div>

        <div className="variant-conclusion-panel">
          <div className="variant-conclusion-panel-head">
            <b>子销量 TOP5</b>
            <span>当期可核验销量</span>
          </div>
          <div className="variant-leader-list">
            {conclusion.topChildSales.map(item => (
              <span key={`sales-${item.name}`}>
                <b>{item.rank}</b>
                <em>{item.name}</em>
                <strong>{item.sales.toLocaleString()}</strong>
                <small>
                  子销量合计 · {item.linkCount} 链接
                </small>
              </span>
            ))}
          </div>
        </div>

        {conclusion.used12mCalibration ? (
          <div className="variant-conclusion-panel">
            <div className="variant-conclusion-panel-head">
              <b>近12个月突出子体</b>
              <span>上架跨度 {Math.round(conclusion.launchSpanDays / 30)} 个月 · 已校准</span>
            </div>
            <div className="variant-leader-list">
              {conclusion.standout12m.map(item => (
                <span key={`m12-${item.name}`}>
                  <b>{item.rank}</b>
                  <em>{item.name}</em>
                  <strong>{(item.sales12m ?? 0).toLocaleString()}</strong>
                  <small>12个月合计 · 月均 {item.avg12m?.toLocaleString() ?? "—"}</small>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="variant-conclusion-panel stocking-panel">
          <div className="variant-conclusion-panel-head">
            <b>立项备货比例建议</b>
            <span>合计 100%</span>
          </div>
          <div className="variant-stocking-list">
            {conclusion.stockingRatios.map(item => (
              <div key={`stock-${item.name}`} className={`variant-stocking-row role-${item.role}`}>
                <div>
                  <em>{item.name}</em>
                  <small>
                    {roleLabel[item.role]} · {item.reason}
                  </small>
                </div>
                <strong>{item.ratioPct}%</strong>
                <i>
                  <b style={{ width: `${Math.max(8, item.ratioPct)}%` }} />
                </i>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


export default function Home() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const tabParam = searchParams.get("tab");
  const asinsParam = searchParams.get("asins");
  const projectParam = searchParams.get("project");
  const slugParam = pathname.match(/^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)$/)?.[1] ?? null;
  const workspacePath = slugParam ? `/p/${slugParam}` : "/";
  const tabHref = (tabId: TabId) => buildTabHref(tabId, searchParams, workspacePath);
  const initialAsins = resolveActiveAsins(slugParam ? null : asinsParam);
  const activeTab = tabFromParam(tabParam);
  const [market, setMarket] = useState<MarketCode>("US");
  const [inputs, setInputs] = useState(() => buildInputSlots(initialAsins));
  const [activeAsins, setActiveAsins] = useState(initialAsins);
  const [variantSort, setVariantSort] = useState<VariantSort>("sales");
  const [salesView, setSalesView] = useState<"history" | "revenue" | "prices" | "ranks">("history");
  const [message, setMessage] = useState(
    slugParam
      ? `正在打开工作区 /p/${slugParam}`
      : "根路径不再混合展示全部底库。请输入一批同类 ASIN，或点下方工作区进入 /p/floor-lamps、/p/kick-scooters",
  );
  const [vocRun, setVocRun] = useState<VocRunObservation | null>(null);
  const [selectedVocReportId, setSelectedVocReportId] = useState<string | null>(null);
  const restoringVocRun = useRef<string | null>(null);
  const [syncAsins, setSyncAsins] = useState<string[] | null>(null);
  const syncSuppressedKey = useRef<string | null>(null);
  const autoSyncStartedKey = useRef<string | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(projectParam);
  const [currentProjectName, setCurrentProjectName] = useState<string | null>(null);
  const [savingKeywordCompare, setSavingKeywordCompare] = useState(false);
  const [savingTrafficPromo, setSavingTrafficPromo] = useState(false);
  const [savingChecklist, setSavingChecklist] = useState(false);
  const [refreshingProjectId, setRefreshingProjectId] = useState<string | null>(null);
  const [flyoutGroupId, setFlyoutGroupId] = useState<NavGroupId | null>(null);
  const [flyoutPinned, setFlyoutPinned] = useState(false);
  const [flyoutTop, setFlyoutTop] = useState(96);
  const flyoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flyoutPanelRef = useRef<HTMLElement | null>(null);
  const flyoutPinnedRef = useRef(false);
  const [catalogItems, setCatalogItems] = useState<Product[]>(() => refreshedCatalog as Product[]);
  const [workspaces, setWorkspaces] = useState<AnalysisProject[]>([]);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const products = useMemo(
    () => activeAsins.map(asin => catalogItems.find(p => p.asin === asin) ?? placeholderProduct(asin)),
    [activeAsins, catalogItems]
  );
  const mixedFamilies = useMemo(() => {
    const families = new Set(
      products.map(item => item.productFamily).filter((item): item is NonNullable<Product["productFamily"]> => Boolean(item) && item !== "generic"),
    );
    return families.size > 1;
  }, [products]);
  const selectedVocReport = vocRun?.reports.find(
    (report) => String(report.id ?? "") === selectedVocReportId,
  ) ?? vocRun?.report ?? null;

  const refreshCatalog = useCallback(async () => {
    try {
      const response = await fetch("/api/catalog");
      if (!response.ok) return;
      const payload = (await response.json()) as { items?: Product[] };
      if (Array.isArray(payload.items) && payload.items.length) {
        setCatalogItems(payload.items);
      }
    } catch {
      // 保留打包快照
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshCatalog();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshCatalog]);

  useEffect(() => {
    const runId = vocRunIdFromSearch(searchParams.toString());
    if (!runId || restoringVocRun.current === runId) return;
    restoringVocRun.current = runId;
    void observeVocRun(runId)
      .then(setVocRun)
      .catch((error) => setVocRun({
        kind: "failed",
        runId,
        stage: null,
        report: null,
        reports: [],
        message: error instanceof Error ? error.message : "Unable to restore VOC run",
      }));
  }, [searchParams]);

  useEffect(() => {
    flyoutPinnedRef.current = flyoutPinned;
  }, [flyoutPinned]);

  useEffect(() => {
    localAgentFetch("/v1/local-data/projects?kind=analysis")
      .then(res => res.json())
      .then(payload => setWorkspaces(Array.isArray(payload.projects) ? payload.projects : []))
      .catch(() => setWorkspaces([]));
  }, [currentProjectId]);

  const clearFlyoutCloseTimer = () => {
    if (flyoutCloseTimer.current) {
      clearTimeout(flyoutCloseTimer.current);
      flyoutCloseTimer.current = null;
    }
  };

  const alignFlyoutToTrigger = (trigger: HTMLElement) => {
    const rail = trigger.closest(".nav-rail") ?? trigger;
    const top = trigger.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    setFlyoutTop(Math.max(8, top));
  };

  const openFlyout = (id: NavGroupId, trigger?: HTMLElement | null) => {
    if (trigger) alignFlyoutToTrigger(trigger);
    clearFlyoutCloseTimer();
    setFlyoutGroupId(id);
  };

  const closeFlyout = () => {
    clearFlyoutCloseTimer();
    setFlyoutPinned(false);
    setFlyoutGroupId(null);
  };

  const toggleFlyout = (id: NavGroupId, trigger?: HTMLElement | null) => {
    if (trigger) alignFlyoutToTrigger(trigger);
    clearFlyoutCloseTimer();
    if (flyoutGroupId === id && flyoutPinned) {
      closeFlyout();
      return;
    }
    setFlyoutPinned(true);
    setFlyoutGroupId(id);
  };

  const scheduleCloseFlyout = () => {
    if (flyoutPinnedRef.current) return;
    clearFlyoutCloseTimer();
    flyoutCloseTimer.current = setTimeout(() => {
      if (flyoutPinnedRef.current) return;
      setFlyoutGroupId(null);
      flyoutCloseTimer.current = null;
    }, 240);
  };

  useEffect(() => () => clearFlyoutCloseTimer(), []);

  useLayoutEffect(() => {
    if (!flyoutGroupId || !flyoutPanelRef.current) return;
    const panel = flyoutPanelRef.current;
    const rail = panel.closest(".nav-rail");
    if (!rail) return;
    const height = panel.offsetHeight;
    const railHeight = rail.getBoundingClientRect().height;
    const margin = 8;
    const maxTop = Math.max(margin, railHeight - height - margin);
    setFlyoutTop(current => Math.min(Math.max(current, margin), maxTop));
  }, [flyoutGroupId]);

  useEffect(() => {
    if (!flyoutGroupId) return;
    const onPointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      const inside = path.some(
        node =>
          node instanceof Element &&
          node.closest(".nav-rail, .sidebar-flyout, .voc-tertiary-open"),
      );
      if (inside) return;
      closeFlyout();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFlyout();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [flyoutGroupId]);

  const startSyncIfNeeded = useCallback(async (values: string[], { force = false } = {}) => {
    const key = values.join(",");
    if (values.length < 3) return false;
    if (!force && syncSuppressedKey.current === key) return false;
    if (!force && autoSyncStartedKey.current === key && syncAsins) return false;

    if (!force) {
      const pendingCatalog = values.filter(v => !catalogItems.some(p => p.asin === v)).length;
      let needsMcpSync = pendingCatalog > 0;
      try {
        const response = await localAgentFetch(`/v1/local-data/sync-asins?asins=${encodeURIComponent(key)}`);
        if (response.ok) {
          const payload = await response.json();
          needsMcpSync = Boolean(payload.needsSync);
        }
      } catch {
        needsMcpSync = pendingCatalog > 0;
      }
      if (!needsMcpSync) return false;
    }

    autoSyncStartedKey.current = key;
    syncSuppressedKey.current = null;
    setSyncAsins(values);
    setMessage(`已加入 ${values.length} 个竞品，后台正在全自动拉取数据（含 VOC）…`);
    return true;
  }, [syncAsins, catalogItems]);

  useEffect(() => {
    if (activeTab !== "overview") return;
    if (syncAsins) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void startSyncIfNeeded(activeAsins);
    });
    return () => {
      cancelled = true;
    };
  }, [activeAsins, activeTab, syncAsins, startSyncIfNeeded]);

  useEffect(() => {
    const parsed = parseAsinsParam(asinsParam);
    if (slugParam) return;
    if (!parsed) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setActiveAsins(current => (current.join(",") === parsed.join(",") ? current : parsed));
      setInputs(buildInputSlots(parsed));
    });
    return () => {
      cancelled = true;
    };
  }, [asinsParam, slugParam]);

  const applyProject = (project: AnalysisProject, options?: { announce?: boolean; replace?: boolean }) => {
    const nextMarket = (project.marketplace in markets ? project.marketplace : "US") as MarketCode;
    setMarket(nextMarket);
    setActiveAsins(project.asins);
    setInputs(buildInputSlots(project.asins));
    setCurrentProjectId(project.id);
    setCurrentProjectName(project.name);
    if (project.name && project.categoryLabel && project.name !== project.categoryLabel && !project.name.startsWith(`${project.categoryLabel} ·`)) {
      setWorkspaceLabel(project.name);
    } else {
      setWorkspaceLabel("");
    }
    const params = new URLSearchParams(window.location.search);
    params.delete("asins");
    params.delete("project");
    if (!project.slug) {
      params.set("asins", project.asins.join(","));
      params.set("project", project.id);
    }
    const href = workspaceHref(project.slug, params);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== href) {
      if (options?.replace) router.replace(href);
      else router.push(href);
    }
    if (options?.announce !== false) {
      setMessage(`已加载项目「${project.name}」· ${project.asins.length} 个 ASIN · ${project.slug ? `/p/${project.slug}` : ""}`);
    }
  };

  useEffect(() => {
    const key = slugParam || projectParam;
    if (!key) {
      if (!parseAsinsParam(asinsParam)) {
        let cancelled = false;
        queueMicrotask(() => {
          if (cancelled) return;
          setCurrentProjectId(null);
          setCurrentProjectName(null);
        });
        return () => {
          cancelled = true;
        };
      }
      return;
    }
    let cancelled = false;
    localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(key)}`)
      .then(res => res.json())
      .then(payload => {
        if (cancelled) return;
        if (!payload.project) {
          setMessage(`找不到工作区 /p/${key}，请从项目收藏打开或重新分析`);
          return;
        }
        const project = payload.project as AnalysisProject;
        const nextMarket = (project.marketplace in markets ? project.marketplace : "US") as MarketCode;
        setMarket(nextMarket);
        setActiveAsins(project.asins);
        setInputs(buildInputSlots(project.asins));
        setCurrentProjectId(project.id);
        setCurrentProjectName(project.name);
        if (project.name && project.categoryLabel && project.name !== project.categoryLabel && !project.name.startsWith(`${project.categoryLabel} ·`)) {
          setWorkspaceLabel(project.name);
        } else {
          setWorkspaceLabel("");
        }
        if (project.slug && slugParam !== project.slug) {
          const params = new URLSearchParams(window.location.search);
          params.delete("asins");
          params.delete("project");
          router.replace(workspaceHref(project.slug, params));
        }
      })
      .catch(() => {
        if (!cancelled) setCurrentProjectName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slugParam, projectParam, router, asinsParam]);

  const nav: NavEntry[] = useMemo(
    () => [
      {
        id: "overview-group",
        label: "竞品概览",
        sub: "参数 · 主辅图 · A+",
        children: [
          { id: "overview", label: "竞品参数总览", sub: "参数 · 趋势 · 变体" },
          { id: "overview-images", label: "主辅图", sub: "主图 · 辅图 · 图册对比" },
          { id: "overview-aplus", label: "高级 A+", sub: "A+ · EBC · 视频 · LQS" },
        ],
      },
      {
        id: "voc-group",
        label: "VOC",
        sub: "原始矩阵 · 洞察立项",
        children: [
          { id: "voc", label: "竞品VOC 汇总", sub: "七维 · 评论 · 综合" },
          { id: "launch", label: "竞品 VOC 洞察", sub: "摘要 · 好评 · 差评 · 未满足" },
          { id: "voc-positioning", label: "产品定义结论", sub: "定位 · 三表合并 · 优化优先级" },
        ],
      },
      {
        id: "keywords-group",
        label: "关键词调研",
        sub: "竞品词分析 · 洞察",
        children: [
          { id: "keywords", label: "竞品关键词分析", sub: "含义分类 · 流量词对比" },
          { id: "keyword-insight", label: "关键词洞察", sub: "开品结论 · 需求分层" },
        ],
      },
      { id: "definition", label: "新品定义", sub: "VOC×关键词 · 最终定义" },
      { id: "checklist", label: "立项前确认清单", sub: "合规 · 专利 · 一票否决" },
      { id: "traffic", label: "竞品流量分析", sub: "结构 · 月趋势 · 推广结论" },
      {
        id: "projects-group",
        label: "收藏夹",
        sub: "项目收藏 · 流量词对比 · 推广能力 · 确认清单",
        children: [
          { id: "projects", label: "项目收藏", sub: "对标组合 · 参数总览 · 团队共享" },
          { id: "keyword-compare", label: "流量词对比", sub: "流量词矩阵 · 竞品对比 · 搜索意图" },
          { id: "traffic-promo", label: "竞品推广能力分析", sub: "流量结构 · 广告分布 · 推广结论" },
          { id: "checklist-library", label: "项目确认清单", sub: "合规认证 · 专利排查 · 一票否决" },
        ],
      },
    ],
    []
  );
  const activeFlyoutGroup = flyoutGroupId
    ? nav.find((entry): entry is NavGroup => isNavGroup(entry) && entry.id === flyoutGroupId) ?? null
    : null;
  const flyoutOpen = Boolean(activeFlyoutGroup);
  const activeLeaf = (() => {
    for (const entry of nav) {
      if (isNavGroup(entry)) {
        const child = entry.children.find(item => item.id === activeTab);
        if (child) return { parent: entry.label, ...child };
      } else if (entry.id === activeTab) {
        return { parent: null as string | null, ...entry };
      }
    }
    return { parent: null as string | null, id: "overview" as TabId, label: "竞品概览", sub: "" };
  })();
  const pageTitle = activeLeaf.parent ? `${activeLeaf.parent} · ${activeLeaf.label}` : activeLeaf.label;
  const persistAsins = (values: string[], projectId: string | null = currentProjectId) => {
    const params = new URLSearchParams(window.location.search);
    if (slugParam) {
      params.delete("asins");
      params.delete("project");
      replaceAppUrl(params, workspacePath);
      return;
    }
    params.set("asins", values.join(","));
    setProjectParam(params, projectId);
    replaceAppUrl(params, "/");
  };

  const ensureAnalysisWorkspace = async (asins: string[]) => {
    const pool = asins
      .map(asin => catalogItems.find(item => item.asin === asin))
      .filter((item): item is Product => Boolean(item));
    const categoryHint =
      pool.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? "竞品分析";
    const alias = workspaceLabel.trim();
    const overlapRatio = (left: string[], right: string[]) => {
      const overlap = left.filter(asin => right.includes(asin)).length;
      return overlap / Math.max(left.length, right.length, 1);
    };

    if (currentProjectId) {
      try {
        const existingRes = await localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(currentProjectId)}`);
        const existingPayload = await existingRes.json();
        const existing = existingPayload.project as AnalysisProject | undefined;
        const sameMarket = (existing?.marketplace || "US") === market;
        const similarSet = existing ? overlapRatio(existing.asins, asins) >= 0.5 : false;
        if (existing && sameMarket && similarSet) {
          const response = await localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(currentProjectId)}`, {
            method: "PATCH",
            body: JSON.stringify({
              asins,
              marketplace: market,
              ...(alias ? { name: alias } : {}),
            }),
          });
          if (response.ok) return (await response.json()).project as AnalysisProject;
        }
      } catch {
        // 建新工作区
      }
    }

    try {
      const listed = await localAgentFetch("/v1/local-data/projects?kind=analysis").then(res => res.json());
      const same = (listed.projects as AnalysisProject[] | undefined)?.find(
        project => sameAsinSet(project.asins, asins) && (project.marketplace || "US") === market,
      );
      if (same) return same;

      const response = await localAgentFetch("/v1/local-data/projects", {
        method: "POST",
        body: JSON.stringify({
          kind: "analysis",
          name: alias || `${categoryHint} · ${market}`,
          alias: alias || undefined,
          categoryLabel: categoryHint,
          majorCategory: inferAmazonMajorCategory(pool),
          marketplace: market,
          asins,
        }),
      });
      if (!response.ok) return null;
      return (await response.json()).project as AnalysisProject;
    } catch {
      return null;
    }
  };

  const runAnalysis = async () => {
    const values = inputs.map(v => v.trim().toUpperCase()).filter(Boolean);
    if (values.length < 3) return setMessage("请至少输入 3 个竞品 ASIN");
    const invalid = values.find(v => !/^[A-Z0-9]{10}$/.test(v));
    if (invalid) return setMessage(`${invalid} 格式不正确，ASIN 应为 10 位字母或数字`);
    if (new Set(values).size !== values.length) return setMessage("请勿重复输入相同 ASIN");
    setActiveAsins(values);
    setInputs(buildInputSlots(values));
    void (async () => {
      try {
        const submission = await submitVocRun(values, "US");
        const params = searchWithVocRunId(window.location.search, submission.runId);
        replaceAppUrl(params, window.location.pathname);
        restoringVocRun.current = submission.runId;
        setVocRun({
          kind: "active",
          runId: submission.runId,
          stage: null,
          report: null,
          reports: [],
          message: "VOC run queued",
        });
        setVocRun(await waitForVocRun(submission.runId, { onObservation: setVocRun }));
      } catch (error) {
        setVocRun({
          kind: error instanceof TypeError
            ? "offline"
            : error instanceof VocRunClientError ? error.kind : "failed",
          runId: vocRunIdFromSearch(window.location.search),
          stage: null,
          report: null,
          reports: [],
          message: error instanceof TypeError
            ? "Agent Service is offline. Run: npm run agent:dev"
            : error instanceof Error ? error.message : "VOC analysis failed",
        });
      }
    })();
    const project = await ensureAnalysisWorkspace(values);
    if (project) applyProject(project, { announce: false, replace: true });
    else persistAsins(values);
    syncSuppressedKey.current = null;
    autoSyncStartedKey.current = null;
    const started = await startSyncIfNeeded(values, { force: true });
    if (started) {
      setMessage(
        project?.slug
          ? `已加入 ${values.length} 个竞品，工作区 /p/${project.slug} · 后台正在全自动拉取数据`
          : `已加入 ${values.length} 个竞品，后台正在全自动拉取数据（含 VOC）…`,
      );
      return;
    }
    setSyncAsins(null);
    const vocPending = values.filter(asin => {
      const record = rufusVocData[asin];
      return !record || record.captureStatus !== "dialog";
    }).length;
    setMessage(
      vocPending
        ? `已更新 ${values.length} 个竞品；其中 ${vocPending} 个 VOC 核心主题待 Alexa 录入`
        : `已更新 ${values.length} 个竞品的横向分析`,
    );
  };

  const continueVocRun = async (observation: VocRunObservation) => {
    setVocRun(observation);
    if (observation.kind === "active" && observation.runId) {
      setVocRun(await waitForVocRun(observation.runId, { onObservation: setVocRun }));
    }
  };

  const setVocActionFailure = (runId: string, error: unknown) => {
    setVocRun((current) => ({
      kind: error instanceof TypeError ? "offline" : error instanceof VocRunClientError ? error.kind : "failed",
      runId,
      stage: current?.stage ?? null,
      report: current?.report ?? null,
      reports: current?.reports ?? [],
      message: error instanceof TypeError
        ? "Agent Service is offline. Run: npm run agent:dev"
        : error instanceof Error ? error.message : "VOC run action failed",
    }));
  };

  const cancelCurrentVocRun = async () => {
    const runId = vocRun?.runId;
    if (!runId) return;
    try {
      await continueVocRun(await cancelVocRun(runId));
    } catch (error) {
      setVocActionFailure(runId, error);
    }
  };

  const retryCurrentVocStage = async () => {
    const runId = vocRun?.runId;
    if (!runId) return;
    try {
      await continueVocRun(await retryVocStage(runId));
    } catch (error) {
      setVocActionFailure(runId, error);
    }
  };

  const saveKeywordCompareProject = async () => {
    if (activeAsins.length < 3) {
      setMessage("请至少保留 3 个竞品 ASIN 后再保存到流量词对比");
      return;
    }
    setSavingKeywordCompare(true);
    try {
      const categoryHint =
        products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ??
        "竞品关键词";
      const stamp = new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "keyword-compare",
          name: `${categoryHint} · 流量词对比 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: activeAsins,
          note: `来自竞品关键词分析 · ${activeAsins.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "保存失败");
      const project = payload.project as AnalysisProject;
      applyProject(project, { announce: false });
      setMessage(`已保存到收藏夹「流量词对比」：${project.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存到流量词对比失败");
    } finally {
      setSavingKeywordCompare(false);
    }
  };

  const saveTrafficPromoProject = async () => {
    const values = inputs.map(v => v.trim().toUpperCase()).filter(Boolean);
    if (values.length < 3) {
      setMessage("请至少保留 3 个竞品 ASIN 后再保存到推广能力分析");
      return;
    }
    const invalid = values.find(v => !/^[A-Z0-9]{10}$/.test(v));
    if (invalid) {
      setMessage(`${invalid} 格式不正确，ASIN 应为 10 位字母或数字`);
      return;
    }
    if (new Set(values).size !== values.length) {
      setMessage("请勿重复输入相同 ASIN");
      return;
    }
    setActiveAsins(values);
    setInputs(buildInputSlots(values));
    persistAsins(values);
    setSavingTrafficPromo(true);
    try {
      const categoryHint =
        products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ??
        "竞品流量";
      const stamp = new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "traffic-promo",
          name: `${categoryHint} · 推广能力分析 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: values,
          note: `来自竞品流量分析 · ${values.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "保存失败");
      const project = payload.project as AnalysisProject;
      applyProject(project, { announce: false });
      setMessage(`已保存到收藏夹「竞品推广能力分析」：${project.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存到推广能力分析失败");
    } finally {
      setSavingTrafficPromo(false);
    }
  };

  const saveChecklistProject = async () => {
    if (activeAsins.length < 3) {
      setMessage("请至少保留 3 个竞品 ASIN 后再保存到项目确认清单");
      return;
    }
    setSavingChecklist(true);
    try {
      const categoryHint =
        products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ??
        "立项确认";
      const stamp = new Date().toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "checklist",
          name: `${categoryHint} · 立项确认清单 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: activeAsins,
          note: `来自立项前确认清单 · ${activeAsins.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "保存失败");
      const project = payload.project as AnalysisProject;
      applyProject(project, { announce: false });
      setMessage(`已保存到收藏夹「项目确认清单」：${project.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存到项目确认清单失败");
    } finally {
      setSavingChecklist(false);
    }
  };

  return <main className={`app-shell${flyoutOpen ? " flyout-open" : ""}`}>
    <div className="nav-rail">
    <aside className="sidebar">
      <div className="brand-mark">
        <span className="brand-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" width={38} height={38} fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="brandTile" x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
                <stop stopColor="#2B3648"/>
                <stop offset="1" stopColor="#1A2332"/>
              </linearGradient>
              <linearGradient id="brandAccent" x1="14" y1="30" x2="36" y2="14" gradientUnits="userSpaceOnUse">
                <stop stopColor="#FFB84D"/>
                <stop offset="1" stopColor="#FF9900"/>
              </linearGradient>
            </defs>
            <g>
              <rect x="4" y="4" width="40" height="40" rx="12" fill="url(#brandTile)"/>
              {/* opportunity rising bars */}
              <path d="M12.5 31.5V27.2M17 31.5V23.5M21.5 31.5V20.2" stroke="#8FA0B5" strokeWidth="2.2" strokeLinecap="round"/>
              <path d="M12.5 26.2C16.8 26.2 19.2 20.8 23.8 18.6C27.6 16.8 30.2 14.2 33.8 12.4" stroke="url(#brandAccent)" strokeWidth="2.4" strokeLinecap="round"/>
              <path d="M29.6 12.2h4.8v4.8" stroke="url(#brandAccent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              {/* insight lens */}
              <circle cx="28.2" cy="27.8" r="6.4" stroke="#fff" strokeWidth="2.1"/>
              <path d="M32.8 32.4 36.6 36.2" stroke="#FF9900" strokeWidth="2.3" strokeLinecap="round"/>
              <circle cx="28.2" cy="27.8" r="2.1" fill="#FF9900"/>
            </g>
          </svg>
        </span>
        <div className="brand-copy">
          <strong>
            <span className="brand-amazon-logo">
              <img src="/amazon-logo.svg" alt="Amazon" width={88} height={27} />
            </span>
            产品机会洞察
          </strong>
        </div>
      </div>
      <nav>
        {nav.map(entry => (
          <Fragment key={entry.id}>
            {isNavGroup(entry) ? (
              <button
                type="button"
                data-dim={entry.id}
                aria-expanded={flyoutGroupId === entry.id}
                aria-controls="sidebar-flyout"
                className={`nav-item nav-group-trigger${entry.children.some(child => child.id === activeTab) || flyoutGroupId === entry.id ? " active" : ""}`}
                onMouseEnter={event => openFlyout(entry.id, event.currentTarget)}
                onMouseLeave={scheduleCloseFlyout}
                onFocus={event => openFlyout(entry.id, event.currentTarget)}
                onClick={event => toggleFlyout(entry.id, event.currentTarget)}
                onBlur={event => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    scheduleCloseFlyout();
                  }
                }}
              >
                <NavThemeIcon dim={entry.id} />
                <span className="nav-item-copy">
                  <b>{entry.label}</b>
                  <NavSubText text={entry.sub} />
                </span>
                <span className="nav-chevron" aria-hidden="true" />
              </button>
            ) : (
              <Link
                href={tabHref(entry.id)}
                data-dim={entry.id}
                className={activeTab === entry.id ? "nav-item active" : "nav-item"}
                onClick={closeFlyout}
              >
                <NavThemeIcon dim={entry.id} />
                <span className="nav-item-copy">
                  <b>{entry.label}</b>
                  <NavSubText text={entry.sub} />
                </span>
              </Link>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="sync-status"><i/>数据源状态正常</div>
        <p>{markets[market].label} · 当前对比<br/><b>{products.length} 个 ASIN</b></p>
      </div>
    </aside>

    <aside
      id="sidebar-flyout"
      ref={flyoutPanelRef}
      className={`sidebar-flyout${flyoutOpen ? " open" : ""}`}
      aria-hidden={!flyoutOpen}
      aria-label={activeFlyoutGroup ? `${activeFlyoutGroup.label} 三级页面` : "三级导航"}
      style={{ top: flyoutTop }}
      onMouseEnter={clearFlyoutCloseTimer}
      onMouseLeave={scheduleCloseFlyout}
    >
      {activeFlyoutGroup ? (
        <div className="sidebar-flyout-list">
          {activeFlyoutGroup.children.map(child => (
            <Link
              key={child.id}
              href={tabHref(child.id)}
              data-dim={child.id}
              className={activeTab === child.id ? "sidebar-flyout-item active" : "sidebar-flyout-item"}
              onClick={closeFlyout}
            >
              <NavThemeIcon dim={child.id} />
              <span className="nav-item-copy">
                <b>{child.label}</b>
                <NavSubText text={child.sub} />
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </aside>
    </div>

    <section className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">{products[0]?.subRankCategory && products[0].subRankCategory !== "等待同步" ? products[0].subRankCategory : "竞品分析"} · Amazon {markets[market].short}</p>
          <h1>{pageTitle}</h1>
        </div>
        <div className="top-actions">
          {activeTab === "keywords" ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={savingKeywordCompare || activeAsins.length < 3}
                onClick={() => void saveKeywordCompareProject()}
              >
                {savingKeywordCompare ? "保存中…" : "保存到流量词对比"}
              </button>
              <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
                抓取关键词数据
              </button>
            </>
          ) : activeTab === "traffic" ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={savingTrafficPromo || inputs.filter(Boolean).length < 3}
                onClick={() => void saveTrafficPromoProject()}
              >
                {savingTrafficPromo ? "保存中…" : "保存到推广能力分析"}
              </button>
              <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
                抓取流量数据
              </button>
            </>
          ) : activeTab === "checklist" ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={savingChecklist || activeAsins.length < 3}
                onClick={() => void saveChecklistProject()}
              >
                {savingChecklist ? "保存中…" : "保存到项目确认清单"}
              </button>
              <Link className="primary-btn" href={tabHref("overview")}>管理竞品 ASIN</Link>
            </>
          ) : (
            <>
              <button className="ghost-btn">导出对比报告</button>
              <Link className="primary-btn" href={tabHref("overview")}>管理竞品 ASIN</Link>
            </>
          )}
        </div>
      </header>
      <div className="comparison-context"><span>目标市场 <b>{markets[market].label} {markets[market].short}</b></span><span>竞品数量 <b>{products.length} / 10</b></span><span>对比模式 <b>多 ASIN 同屏</b></span><SourceBadge>卖家精灵更新 2026-08-03</SourceBadge></div>

      {activeLeaf.parent ? (
        <div className="voc-tertiary-bar" data-nav-dim={activeTab} aria-label={`${activeLeaf.parent} 当前位置`}>
          <div className="voc-tertiary-crumb">
            <button
              type="button"
              className="voc-tertiary-open"
              onMouseEnter={() => {
                const groupId = groupIdForTab(activeTab);
                if (groupId) {
                  const trigger = document.querySelector<HTMLElement>(`.nav-group-trigger[data-dim="${groupId}"]`);
                  openFlyout(groupId, trigger);
                }
              }}
              onClick={() => {
                const groupId = groupIdForTab(activeTab);
                if (groupId) {
                  const trigger = document.querySelector<HTMLElement>(`.nav-group-trigger[data-dim="${groupId}"]`);
                  toggleFlyout(groupId, trigger);
                }
              }}
            >
              {activeLeaf.parent}
            </button>
            <i>/</i>
            <b>{activeLeaf.label}</b>
          </div>
        </div>
      ) : null}


      {activeTab === "overview" && <div className="page-content compare-page">
        <section className="card asin-builder">
          <div className="section-head"><div><h3>设置对标竞品</h3><p>工作区按「类目 + 站点」分开：美国落地灯是 /p/floor-lamps-us，英国站会是 /p/floor-lamps-uk。同一站点再开一批细分（如儿童三轮 vs 成人滑板车）会再生成新地址。输入 3–10 个 ASIN 后点「开始全自动分析」。</p></div><span className="required-note">3–10 个</span></div>
          <div className="asin-builder-body">
            <div className="builder-meta-row">
            <label className="market-inline">目标市场<select value={market} onChange={e=>{const next=e.target.value as MarketCode;setMarket(next);setMessage(`已切换至 ${markets[next].label}，ASIN 链接与数据口径将同步更新`);}}>{Object.entries(markets).map(([code,item])=><option key={code} value={code}>{item.option}</option>)}</select></label>
            <label className="workspace-alias-field">
              细分名称
              <input
                value={workspaceLabel}
                onChange={e => setWorkspaceLabel(e.target.value)}
                placeholder="可选：儿童三轮 / 置物架灯 / Kids 3-Wheel"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            </div>
            <div className="asin-inputs">{Array.from({ length: MAX_ASIN_SLOTS }).map((_, i) => (
              <label key={i} className="asin-slot">
                <span>{i + 1}{i < 3 && <b>*</b>}</span>
                <input
                  value={inputs[i]}
                  name={`asin-slot-${i}`}
                  placeholder="10位ASIN"
                  maxLength={10}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  onChange={e => setInputs(prev => prev.map((v, j) => (j === i ? e.target.value.toUpperCase() : v)))}
                />
                {i >= 3 && inputs[i] ? (
                  <button
                    type="button"
                    onClick={() => setInputs(prev => prev.map((v, j) => (j === i ? "" : v)))}
                    aria-label={`清空竞品${i + 1}`}
                  >
                    ×
                  </button>
                ) : null}
              </label>
            ))}</div>
            {workspaces.length > 0 ? (
              <div className="workspace-switcher" aria-label="已保存的分析工作区">
                {workspaces.map(workspace => (
                  <Link
                    key={workspace.id}
                    href={projectWorkspacePath(workspace.slug)}
                    className={`workspace-chip${workspace.id === currentProjectId ? " active" : ""}`}
                  >
                    {workspace.categoryLabel || workspace.name}
                    <small>
                      /p/{workspace.slug}
                      {workspace.marketplace ? ` · ${workspace.marketplace}` : ""}
                    </small>
                  </Link>
                ))}
              </div>
            ) : null}
            {mixedFamilies ? (
              <p className="mixed-family-note">
                当前表里混了不同品类。请分别打开对应工作区，不要把滑板车和落地灯放在同一页对比。
              </p>
            ) : null}
          </div>
          <div className="builder-actions">
            <Link className="ghost-btn" href={tabHref("projects")}>★ 项目收藏</Link>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            <span className={message.includes("请")||message.includes("不正确")||message.includes("重复")?"builder-message error":"builder-message"}>{message}</span>
            <button className="primary-btn" onClick={runAnalysis}>开始全自动分析</button>
          </div>
        </section>

        {activeAsins.length > 0 || syncAsins ? (
        <AsinSyncProgressSection
          asins={activeAsins}
          marketplace={market}
          syncRequest={syncAsins}
          onRequestSync={() => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          }}
          onSyncComplete={() => {
            void refreshCatalog();
            setMessage("MCP 同步完成，数据已写入并重新构建");
          }}
          onSyncDismiss={() => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
          }}
        />
        ) : null}

        <CategoryNodeTrendSection
          marketplace={market}
          products={products.map(p => ({ asin: p.asin, brand: p.brand, subRankCategory: p.subRankCategory }))}
        />

        <section className="card compare-table-card"><div className="section-head"><div><h3>竞品参数总览</h3><p>{slugParam ? `当前工作区 /p/${slugParam} · 仅展示本批对标 ASIN` : "同一工作区内的竞品对齐查看；不同品类请用各自的 /p/ 地址"}；点击 ASIN 可打开对应站点前台</p></div><SourceBadge>卖家精灵 MCP</SourceBadge></div><div className="matrix-wrap"><table className="compare-matrix"><thead><tr><th>指标</th>{products.map((p,i)=><th key={p.asin}><ProductHeader product={p} index={i} market={market}/></th>)}</tr></thead><tbody>
          <tr><th>当前售价</th>{products.map(p=><td key={p.asin}><strong>{p.price===null?"—":`$${p.price}`}</strong></td>)}</tr>
          <tr><th>30天销量<small className="insight-source">Sorftime · 悬停趋势图</small></th>{products.map((p,i)=><td key={p.asin}><SalesTrendSparkline asin={p.asin} sales30d={p.sales} color={colors[i]}/></td>)}</tr>
          <tr><th>评分 / 评论<small className="insight-source">Sorftime MCP</small></th>{products.map(p=>{const record=sorftimeRatingData[p.asin];const rating=record?.status==="ready"?record.rating:null;const reviews=record?.status==="ready"?record.reviewCount:null;return <td key={p.asin}>{rating===null?"—":<RatingCell rating={rating} reviews={reviews}/>}</td>})}</tr>
          <tr><th>Best Seller Rank</th>{products.map(p=><td key={p.asin}>{p.subRank===null?"—":<div className="rank-lines"><b>#{p.rank?.toLocaleString()} in {p.rankCategory}</b><small>#{p.subRank} in {p.subRankCategory}</small></div>}</td>)}</tr>
          <tr><th>购物车卖家</th>{products.map(p=><td key={p.asin}>{p.buyBoxSeller}</td>)}</tr>
          <tr><th>配送方式</th>{products.map(p=><td key={p.asin}>{p.fulfillment}</td>)}</tr>
          <tr><th>产品包装</th>{products.map(p=><td key={p.asin}><b>{p.packageSize}</b><small>{p.packageWeight}</small></td>)}</tr>
          <tr><th>FBA 费用<small className="insight-source">Keepa · 配送费</small></th>{products.map(p=>{const record=sorftimeFbaFeeData[p.asin];return <td key={p.asin}>{record?.status==="ready"&&record.fbaFee!=null?<div className="fba-fee-cell"><strong>${record.fbaFee.toFixed(2)}</strong>{record.packageSize?<small title={record.note??undefined}>{record.packageSize}{record.packageWeight?` · ${record.packageWeight}`:""}</small>:null}</div>:<span className="no-data-text">{sorftimeFbaFeeMeta.emptyMessage}</span>}</td>})}</tr>
          <tr><th>产品规格<small className="insight-source">Features &amp; Specs</small></th>{products.map(p=><td key={p.asin}><div className="spec-lines">{p.specifications.map(spec=><div key={spec}>{spec}</div>)}</div></td>)}</tr>
          <tr><th>上架时间</th>{products.map(p=><td key={p.asin}>{p.launch}</td>)}</tr><tr><th>变体主题</th>{products.map(p=><td key={p.asin}>{variationTheme(p)}</td>)}</tr><tr><th>变体数量</th>{products.map(p=><td key={p.asin}>{p.variants}</td>)}</tr>
          <tr><th>近30天子体销量<small className="insight-source">Sorftime MCP</small></th>{products.map(p=>{const items=[...(sorftimeChildSales30d[p.asin]??[])].sort((a,b)=>b.sales-a.sales||a.variant.localeCompare(b.variant)).slice(0,5);return <td key={p.asin}><ChildSalesBars items={items}/></td>})}</tr>
          <tr><th>价格策略分析<small className="insight-source">Sorftime MCP</small></th>{products.map(p=>{const strategy=sorftimePriceStrategies[p.asin];return <td key={p.asin}>{strategy?<div className="price-strategy-cell"><p><b>定价锚点</b>{strategy.anchor}</p><p><b>促销手法</b>{strategy.promotion}</p><p><b>折扣心理</b>{strategy.psychology}</p><small>{strategy.evidence}</small></div>:<span className="no-data-text">{sorftimePriceStrategyMeta.emptyMessage}</span>}</td>})}</tr>
          <tr><th>主要卖点<small className="insight-source">Amazon Bullet Point 总结</small></th>{products.map(p=><td key={p.asin} className="selling-points-cell"><ul>{p.sellingPoints.map((point,index)=><li key={`${p.asin}-bp-${index}`}>{point}</li>)}</ul></td>)}</tr>
        </tbody></table></div></section>

        <section className="card compare-chart-card sales-combined-card">
          <div className="section-head">
            <div>
              <h3>竞品历史数据追踪</h3>
              <p>
                {salesView === "history"
                  ? "月销量 · 同一坐标系查看增速、体量与拐点"
                  : salesView === "revenue"
                    ? "月销售额 · Sorftime SalesAmount · USD"
                    : salesView === "prices"
                      ? "历史价格 · 月均价 · USD"
                      : "大类 BSR · 越靠上表现越优"}
                {sorftimeSalesTrendMeta.updatedAt ? ` · 同步至 ${sorftimeSalesTrendMeta.updatedAt}` : ""}
              </p>
            </div>
            <div className="chart-head-actions">
              <div className="chart-view-switch" role="group" aria-label="切换历史数据指标">
                <button className={salesView === "history" ? "selected" : ""} aria-pressed={salesView === "history"} onClick={() => setSalesView("history")}>
                  月销量
                </button>
                <button className={salesView === "revenue" ? "selected" : ""} aria-pressed={salesView === "revenue"} onClick={() => setSalesView("revenue")}>
                  月销售额
                </button>
                <button className={salesView === "prices" ? "selected" : ""} aria-pressed={salesView === "prices"} onClick={() => setSalesView("prices")}>
                  历史价格
                </button>
                <button className={salesView === "ranks" ? "selected" : ""} aria-pressed={salesView === "ranks"} onClick={() => setSalesView("ranks")}>
                  大类 BSR
                </button>
              </div>
              <SourceBadge>Sorftime MCP</SourceBadge>
            </div>
          </div>
          <div className="chart-legend">
            {products.map((p, i) => (
              <span key={p.asin}>
                <i style={{ background: colors[i] }} />
                {p.brand}
              </span>
            ))}
          </div>
          <ComparisonChart key={salesView} products={products} metric={salesView} inverse={salesView === "ranks"} />
        </section>

        <section className="card variant-section"><div className="section-head"><div><h3>变体评论结构与上架时间</h3><p>{sellerSpriteVariantMeta.note}</p></div><div className="variant-controls"><label>默认排序<select value={variantSort} onChange={e=>setVariantSort(e.target.value as VariantSort)}><option value="sales">子销量 ↓</option><option value="reviews">评论数 ↓</option><option value="share">评论占比 ↓</option><option value="launch">上架时间 ↓</option></select></label><SourceBadge>卖家精灵 MCP</SourceBadge></div></div><div className="variant-compare-grid">{products.map((p,i)=>{const items=sortedVariants(sellerSpriteVariantData[p.asin]??[],variantSort);const knownShares=items.filter(v=>v.reviewShare!==null);return <div key={p.asin} className="variant-compare"><ProductHeader product={p} index={i} market={market}/>{items.length?<><VariantShareStructure items={items}/><div className="variant-labels"><span>已核验 <b>{knownShares.length}/{items.length}</b> 个变体</span><span>评论占比合计 <b>{Math.round(knownShares.reduce((sum,item)=>sum+(item.reviewShare??0),0))}%</b></span></div><VariantDetailTable items={items} currentAsin={p.asin} /><VariantSummary items={items}/></>:<div className="pending-box">卖家精灵未返回变体数据</div>}</div>})}</div><VariantPortfolioSummary products={products}/></section>
      </div>}

      {activeTab === "overview-images" && (
        <div className="page-content compare-page">
          <section className="card page-intro">
            <div>
              <span className="status-chip">Listing 图册</span>
              <h2>纵向 ASIN、横向图片 1–9，同屏横向比较各竞品主图与辅图策略</h2>
              <p>布局对齐 Excel 竞品图册表：每行一个 ASIN，每列同一顺位素材；第 1 列为主图，其余为辅图；每张图下方灰色卡片为视觉结构摘要。</p>
            </div>
            <SourceBadge>Sorftime MCP</SourceBadge>
          </section>
          <ListingImagesSection
            products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
            market={markets[market]}
            colors={colors}
          />
        </div>
      )}

      {activeTab === "overview-aplus" && (
        <div className="page-content compare-page">
          <section className="card page-intro">
            <div>
              <span className="status-chip">富内容配置</span>
              <h2>对比 A+、EBC、主图视频与 Listing 质量分，判断富内容投入差距</h2>
              <p>Sorftime 提供 A+ 有无；卖家精灵补充 EBC / 视频 / LQS。Premium A+ 模块需跳转 Listing 核验。</p>
            </div>
            <SourceBadge>Sorftime + 卖家精灵</SourceBadge>
          </section>
          <ListingAplusSection
            products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title, image: p.image }))}
            market={markets[market]}
            colors={colors}
          />
        </div>
      )}

      {activeTab === "voc" && <div className="page-content compare-page">
        <section className="card page-intro"><div><span className="status-chip">多竞品 VOC 对比</span><h2>七个相同维度同屏对齐，直接比较顾客关注与购买决策差异</h2><p>入口：Alexa for Shopping 对话框 · 中文七问一次性提交 · 输出完整报告 · 数据源为 Customer Review（经 Alexa 整理）。</p></div><SourceBadge>{products.length} 个 ASIN 同屏</SourceBadge></section>
        <section className="card voc-dimension-format-card">
          <div className="section-head"><div><h3>VOC 核心主题 · 七维格式</h3><p>矩阵左列展示格式说明，各 ASIN 列按同一结构对齐</p></div><SourceBadge>{rufusVocMeta.source}</SourceBadge></div>
          <table className="voc-dimension-format-table">
            <thead><tr><th>维度</th><th>格式说明</th></tr></thead>
            <tbody>
              {rufusVocDimensions.map(d => (
                <tr key={d.key}>
                  <th>
                    <VocDimensionLabel label={d.label} description={d.description} />
                  </th>
                  <td>{d.formatHint}</td>
                </tr>
              ))}
              <tr className="voc-dimension-format-note-row">
                <th>备注</th>
                <td>Alexa for Shopping 聊天框提问，提问格式为：这个产品的顾客关注点是什么、好评点是什么、差评点是什么、未被满足的需求是什么、使用人群是谁、使用场景是什么、核心购买动机是什么。</td>
              </tr>
            </tbody>
          </table>
        </section>
        <AlexaVocImportPanel products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title }))} />
        <section className="card voc-matrix-card"><div className="section-head"><div><h3>VOC 核心主题</h3><p>{rufusVocMeta.scope}</p></div><SourceBadge>Customer Review</SourceBadge></div><div className="matrix-wrap"><table className="compare-matrix voc-matrix"><thead><tr><th>VOC 维度</th>{products.map((p,i)=><th key={p.asin}><ProductHeader product={p} index={i} market={market}/></th>)}</tr></thead><tbody>{rufusVocDimensions.map(dimension=><tr key={dimension.key}><th><VocDimensionLabel label={dimension.label} description={dimension.description} /><small className={dimension.verified?"voc-status verified":"voc-status limited"}>{dimension.formatHint}</small></th>{products.map(p=>{const record=rufusVocData[p.asin];const items=record?.[dimension.key]??["该 ASIN 尚未在 Alexa for Shopping 对话框提问。"];const isPending=record?.captureStatus==="pending";const isTableRow=record?.captureStatus==="dialog"&&(dimension.key==="audiences"||dimension.key==="scenarios"||dimension.key==="motives");const cellClass=!dimension.verified?"bullet-cell voc-limited-cell":isPending?"bullet-cell voc-limited-cell":record?.captureStatus==="dialog"?"bullet-cell voc-alexa-cell":"bullet-cell";return <td key={p.asin} className={cellClass}><ul className={isTableRow?"voc-table-list":undefined}>{items.map((item,index)=><li key={`${p.asin}-${dimension.key}-${index}`} className={item.includes("｜")&&index===0?"voc-table-head":undefined}>{renderVocMatrixItem(item, dimension.key)}</li>)}</ul></td>})}</tr>)}</tbody></table></div><p className="voc-source-footnote">入口：{rufusVocMeta.source} · 提问：中文七问 · 输出：完整报告 · 数据源：Customer Review（经 Alexa 整理）· {rufusVocMeta.capturedAt}</p></section>
        <ReviewAnalysisMatrixSection
          title="智能评论分析"
          description={`Sorftime MCP · Customers Say 主题 + 近一年评论样本 · 六维同屏对齐 · 格式：【分类】+ 提及占比 · 更新：${sorftimeReviewDataMeta.updatedAt}`}
          badge="Sorftime MCP"
          data={sorftimeReviewAnalysisData}
          dataMeta={sorftimeReviewDataMeta}
          configMeta={sorftimeReviewAnalysisMeta}
          pendingSteps={
            <>
              1) Cursor Settings → MCP → 启用 sorftime-mcp · 2) 运行 <code>{sorftimeReviewAnalysisMeta.syncCommand}</code> · 3){" "}
              <code>npm run build</code> 并重启团队服务
            </>
          }
          products={products}
          market={market}
        />
        <VocSevenDimensionInsightSection products={products} />
        {vocRun ? (
          <section className="card launch-block" data-voc-run={vocRun.runId ?? undefined}>
            <strong>VOC Agent · {vocRun.kind}</strong>
            <p>{vocRun.message}</p>
            {vocRun.runId ? <small>Run {vocRun.runId}</small> : null}
            <p>
              Stage: {String(vocRun.stage?.status ?? "queued")} · {String(vocRun.stage?.progress ?? 0)}%
            </p>
            {vocRun.stage?.lastError ? (
              <p>{typeof vocRun.stage.lastError === "object" && vocRun.stage.lastError && "message" in vocRun.stage.lastError
                ? String(vocRun.stage.lastError.message)
                : String(vocRun.stage.lastError)}</p>
            ) : null}
            {vocRun.kind === "active" ? (
              <button type="button" className="ghost-btn" onClick={() => void cancelCurrentVocRun()}>取消运行</button>
            ) : null}
            {vocRun.kind === "failed" ? (
              <button type="button" className="ghost-btn" onClick={() => void retryCurrentVocStage()}>重试 VOC 阶段</button>
            ) : null}
            {vocRun.kind === "waiting-input" ? <p>需要补齐可信 VOC 数据后再重试；不会自动采集外部数据。</p> : null}
            {vocRun.reports.length ? (
              <label>
                已保存报告版本
                <select
                  value={selectedVocReportId ?? String(vocRun.report?.id ?? "")}
                  onChange={(event) => setSelectedVocReportId(event.target.value)}
                >
                  {vocRun.reports.map((report, index) => (
                    <option key={String(report.id ?? index)} value={String(report.id ?? "")}>
                      v{String(report.version ?? index + 1)} · {String(report.status ?? "complete")}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {selectedVocReport ? (
              <p>
                Report v{String(selectedVocReport.version ?? 1)} · {String(selectedVocReport.status ?? "complete")} · {String(
                  (selectedVocReport.result as { coreConclusion?: { strategy?: string } } | undefined)?.coreConclusion?.strategy ?? "已持久化",
                )}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>}

      {activeTab === "keywords" && <div className="page-content compare-page">
        <section className="card asin-builder">
          <div className="section-head">
            <div>
              <h3>本页独立设置竞品 ASIN</h3>
              <p>无需先去竞品概览；在此录入 3–10 个 ASIN，抓取关键词后即可保存到收藏夹「流量词对比」</p>
            </div>
            <span className="required-note">3–10 个</span>
          </div>
          <div className="asin-builder-body">
            <label className="market-inline">
              目标市场
              <select
                value={market}
                onChange={e => {
                  const next = e.target.value as MarketCode;
                  setMarket(next);
                  setMessage(`已切换至 ${markets[next].label}，关键词数据口径将同步更新`);
                }}
              >
                {Object.entries(markets).map(([code, item]) => (
                  <option key={code} value={code}>
                    {item.option}
                  </option>
                ))}
              </select>
            </label>
            <div className="asin-inputs">
              {Array.from({ length: MAX_ASIN_SLOTS }).map((_, i) => (
                <label key={i} className="asin-slot">
                  <span>
                    {i + 1}
                    {i < 3 && <b>*</b>}
                  </span>
                  <input
                    value={inputs[i]}
                    name={`asin-slot-${i}`}
                    placeholder="10位ASIN"
                    maxLength={10}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-lpignore="true"
                    data-1p-ignore="true"
                    onChange={e => setInputs(prev => prev.map((v, j) => (j === i ? e.target.value.toUpperCase() : v)))}
                  />
                  {i >= 3 && inputs[i] ? (
                    <button
                      type="button"
                      onClick={() => setInputs(prev => prev.map((v, j) => (j === i ? "" : v)))}
                      aria-label={`清空竞品${i + 1}`}
                    >
                      ×
                    </button>
                  ) : null}
                </label>
              ))}
            </div>
          </div>
          <div className="builder-actions">
            <Link className="ghost-btn" href={tabHref("keyword-compare")}>
              ★ 流量词对比
            </Link>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            <span
              className={
                message.includes("请") || message.includes("不正确") || message.includes("重复") || message.includes("失败")
                  ? "builder-message error"
                  : "builder-message"
              }
            >
              {message}
            </span>
            <button type="button" className="ghost-btn" disabled={savingKeywordCompare || activeAsins.length < 3} onClick={() => void saveKeywordCompareProject()}>
              {savingKeywordCompare ? "保存中…" : "保存到流量词对比"}
            </button>
            <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
              抓取关键词数据
            </button>
          </div>
        </section>

        <KeywordFetchStatusSection
          products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
          marketplace={market}
          syncRequest={syncAsins}
          onRequestSync={() => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          }}
          onSyncComplete={() => {
            void refreshCatalog();
            setMessage("关键词相关数据已就绪，可继续分析或保存到流量词对比");
          }}
          onSyncDismiss={() => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
          }}
        />

        <KeywordDemandSection
          mode="analysis"
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title, subRankCategory: p.subRankCategory, image: p.image, price: p.price }))}
        />
      </div>}

      {activeTab === "keyword-insight" && <div className="page-content compare-page">
        <KeywordDemandSection
          mode="insight"
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title, subRankCategory: p.subRankCategory, image: p.image, price: p.price }))}
        />
      </div>}

      {activeTab === "launch" && <div className="page-content compare-page">
        <ProductLaunchRecommendationSection products={products} />
      </div>}

      {activeTab === "voc-positioning" && <div className="page-content compare-page">
        <VocPositioningSection products={products} />
      </div>}

      {activeTab === "definition" && <div className="page-content compare-page">
        <ProductDefinitionSection products={products} />
      </div>}

      {activeTab === "checklist" && <div className="page-content compare-page">
        <LaunchChecklistSection
          products={products.map(p => ({
            asin: p.asin,
            brand: p.brand,
            title: p.title,
            price: p.price,
            sales: p.sales,
            rating: p.rating,
            reviews: p.reviews,
            launch: p.launch,
            subRankCategory: p.subRankCategory,
            rankCategory: p.rankCategory,
          }))}
          onSaveToLibrary={() => void saveChecklistProject()}
          savingToLibrary={savingChecklist}
          canSaveToLibrary={activeAsins.length >= 3}
          libraryHref={tabHref("checklist-library")}
          libraryMessage={
            message.includes("项目确认清单") || message.includes("立项确认清单") ? message : null
          }
        />
      </div>}

      {activeTab === "traffic" && <div className="page-content compare-page">
        <section className="card asin-builder">
          <div className="section-head">
            <div>
              <h3>本页独立设置竞品 ASIN</h3>
              <p>无需先去竞品概览；在此录入 3–10 个 ASIN，抓取流量后即可保存到收藏夹「竞品推广能力分析」</p>
            </div>
            <span className="required-note">3–10 个</span>
          </div>
          <div className="asin-builder-body">
            <label className="market-inline">
              目标市场
              <select
                value={market}
                onChange={e => {
                  const next = e.target.value as MarketCode;
                  setMarket(next);
                  setMessage(`已切换至 ${markets[next].label}，流量数据口径将同步更新`);
                }}
              >
                {Object.entries(markets).map(([code, item]) => (
                  <option key={code} value={code}>
                    {item.option}
                  </option>
                ))}
              </select>
            </label>
            <div className="asin-inputs">
              {Array.from({ length: MAX_ASIN_SLOTS }).map((_, i) => (
                <label key={i} className="asin-slot">
                  <span>
                    {i + 1}
                    {i < 3 && <b>*</b>}
                  </span>
                  <input
                    value={inputs[i]}
                    name={`asin-slot-${i}`}
                    placeholder="10位ASIN"
                    maxLength={10}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-lpignore="true"
                    data-1p-ignore="true"
                    onChange={e => setInputs(prev => prev.map((v, j) => (j === i ? e.target.value.toUpperCase() : v)))}
                  />
                  {i >= 3 && inputs[i] ? (
                    <button
                      type="button"
                      onClick={() => setInputs(prev => prev.map((v, j) => (j === i ? "" : v)))}
                      aria-label={`清空竞品${i + 1}`}
                    >
                      ×
                    </button>
                  ) : null}
                </label>
              ))}
            </div>
          </div>
          <div className="builder-actions">
            <Link className="ghost-btn" href={tabHref("traffic-promo")}>
              ★ 推广能力分析
            </Link>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            <span
              className={
                message.includes("请") || message.includes("不正确") || message.includes("重复") || message.includes("失败")
                  ? "builder-message error"
                  : "builder-message"
              }
            >
              {message}
            </span>
            <button type="button" className="ghost-btn" disabled={savingTrafficPromo || inputs.filter(Boolean).length < 3} onClick={() => void saveTrafficPromoProject()}>
              {savingTrafficPromo ? "保存中…" : "保存到推广能力分析"}
            </button>
            <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
              抓取流量数据
            </button>
          </div>
        </section>

        <TrafficFetchStatusSection
          products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
          marketplace={market}
          syncRequest={syncAsins}
          onRequestSync={() => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          }}
          onSyncComplete={() => {
            void refreshCatalog();
            setMessage("流量相关数据已就绪，可继续分析或保存到推广能力分析");
          }}
          onSyncDismiss={() => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
          }}
        />

        <section className="card page-intro"><div><span className="status-chip">竞品流量分析</span><h2>同屏比较流量结构、月趋势，并输出推广能力结论</h2><p>数据来自 SIF「查流量结构」· {sifListingTrafficMeta.period} · 更新至 {sifListingTrafficMeta.updatedThrough}，统一 Listing 口径。</p></div>
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
                const data = sifListingTrafficOverview[p.asin];
                return (
                  <div className="traffic-distribution-row" key={p.asin}>
                    <div className="traffic-product-cell">
                      <ProductHeader product={p} index={i} market={market} />
                      {data && <small>总分 {data.totalScore.toLocaleString()} · 更新至 {data.updatedThrough ?? sifListingTrafficMeta.updatedThrough}</small>}
                    </div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars items={data?.naturalAd ?? []} palette={["#55BB6A", "#FFB03B"]} /></div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars items={data?.adChannels ?? []} glossary={sifAdChannelGlossary} palette={["#538CEE", "#FFB03B", "#F15C5C", "#55BB6A"]} /></div>
                    <div className="traffic-metric-cell"><TrafficDistributionBars items={data?.recommendationSources ?? []} maxItems={4} palette={["#538CEE", "#55BB6A", "#FFB03B", "#F15C5C"]} /></div>
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
              const data = sifListingTrafficOverview[p.asin];
              return (
                <div className="child-traffic-card" key={p.asin}>
                  <div className="child-traffic-card-head">
                    <ProductHeader product={p} index={i} market={market} />
                    <small>{data?.children.length ?? 0} 个子体 · 总分 {(data?.totalScore ?? 0).toLocaleString()}</small>
                  </div>
                  <ChildTrafficStructurePanel variants={data?.children ?? []} />
                </div>
              );
            })}
          </div>
        </section>

        <section className="card compare-chart-card monthly-traffic-card">
          <div className="section-head">
            <div>
              <h3>月流量趋势对比</h3>
              <p>按品牌分组 · 近6个月自然 / 广告堆叠柱 · 更新至 {sifMonthlyTrafficMeta.updatedThrough}</p>
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
          <MonthlyTrafficStackChart products={products} />
          <p className="traffic-data-note">{sifMonthlyTrafficMeta.note}</p>
        </section>

        <TrafficAnalysisConclusionSection products={products} market={market} />
      </div>}

      {activeTab === "keyword-compare" && <div className="page-content compare-page">
        {syncAsins ? (
          <AsinSyncFunnel
            asins={syncAsins}
            marketplace={market}
            focusStageIds={["catalog", "keywords"]}
            onComplete={() => {
              void refreshCatalog();
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
            onDismiss={() => {
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
          />
        ) : null}
        <ProjectLibraryPage
          kind="keyword-compare"
          title="流量词对比"
          description="收藏从「竞品关键词分析」保存的流量词对比项目。打开后可刷新词数据，或编辑追加新的 ASIN。"
          saveLabel="保存为流量词对比项目"
          loadLabel="打开对比"
          emptyHint="还没有流量词对比项目。请先到「关键词调研 · 竞品关键词分析」点击「保存到流量词对比」。"
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          openInNewTab
          refreshingId={refreshingProjectId}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams, "keywords")}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已打开流量词对比「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false });
            setMessage(`已更新流量词对比「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onRefreshKeywords={project => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          }}
        />
      </div>}

      {activeTab === "traffic-promo" && <div className="page-content compare-page">
        {syncAsins ? (
          <AsinSyncFunnel
            asins={syncAsins}
            marketplace={market}
            focusStageIds={["catalog", "traffic"]}
            onComplete={() => {
              void refreshCatalog();
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
            onDismiss={() => {
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
          />
        ) : null}
        <ProjectLibraryPage
          kind="traffic-promo"
          title="竞品推广能力分析"
          description="收藏从「竞品流量分析」保存的推广能力分析项目。打开后进入流量结构与推广结论页。"
          saveLabel="保存为推广能力分析项目"
          loadLabel="打开分析"
          emptyHint="还没有推广能力分析项目。请先到「竞品流量分析」点击「保存到推广能力分析」。"
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          openInNewTab
          refreshingId={refreshingProjectId}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams, "traffic")}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已打开推广能力分析「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false });
            setMessage(`已更新推广能力分析「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onRefreshKeywords={project => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          }}
        />
      </div>}

      {activeTab === "checklist-library" && <div className="page-content compare-page">
        {syncAsins ? (
          <AsinSyncFunnel
            asins={syncAsins}
            marketplace={market}
            focusStageIds={["catalog", "reviews", "alexa_voc"]}
            onComplete={() => {
              void refreshCatalog();
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
            onDismiss={() => {
              setRefreshingProjectId(null);
              setSyncAsins(null);
            }}
          />
        ) : null}
        <ProjectLibraryPage
          kind="checklist"
          title="项目确认清单"
          description="收藏从「立项前确认清单」保存的项目。打开后进入清单页，可刷新竞品与 VOC 数据，或编辑追加新 ASIN。"
          saveLabel="保存为项目确认清单"
          loadLabel="打开清单"
          emptyHint="还没有项目确认清单。请先到「立项前确认清单」点击「保存到项目确认清单」。"
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          openInNewTab
          refreshingId={refreshingProjectId}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams, "checklist")}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已打开立项确认清单「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false });
            setMessage(`已更新项目确认清单「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onRefreshKeywords={project => {
            applyProject(project, { announce: false });
            setRefreshingProjectId(project.id);
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(project.asins, { force: true }).then(started => {
              if (!started) setRefreshingProjectId(null);
            });
          }}
        />
      </div>}

      {activeTab === "projects" && <div className="page-content compare-page">
        <ProjectLibraryPage
          kind="analysis"
          market={market}
          draftAsins={inputs}
          currentProjectId={currentProjectId}
          suggestedMajorCategory={inferAmazonMajorCategory(products)}
          suggestedCategoryLabel={products.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? null}
          buildLoadHref={project => buildProjectLoadHref(project, searchParams)}
          onLoadProject={project => {
            applyProject(project);
            setMessage(`已加载项目「${project.name}」· ${project.asins.length} 个 ASIN`);
          }}
          onProjectSaved={project => {
            applyProject(project, { announce: false, replace: true });
          }}
        />
      </div>}
    </section>
    <BackToTopButton />
  </main>;
}
