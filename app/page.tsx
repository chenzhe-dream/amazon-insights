"use client";
import { scopedReviewContexts } from '../shared/review-context';
import { ReviewContextSection } from './project-report-views/review-context';
import {priorityRecoveryProjectId,readHistoricalSyncPointer,sourceProjectIdForSave} from "./lib/image-source-project";
import { readCurrentProjectDisplayVersion, type CurrentProjectDisplayVersion } from "./lib/project-display-version-browser";
import {ListingImageSourceProject} from "./listing-image-source-project";
import {publishUsagePage} from "./lib/usage-analytics-browser";

import {CompetitorOverviewMatrix, CompetitorOverviewHistory, CompetitorOverviewCategoryTrend, ProductHeader, colors, markets, type Product, type MarketCode} from "./project-report-views/competitor-overview";
import type {sorftimeSalesTrendData} from "./sorftime-sales-trend-data";
import type {sorftimePriceStrategies} from "./sorftime-price-strategy-data";
import type {sorftimeFbaFeeData} from "./sorftime-fba-fee-data";
import type {sorftimeChildSales30d} from "./sorftime-child-sales-data";
import type {sorftimeRatingData} from "./sorftime-rating-data";
import Link from "next/link";
import {canSeeTab,firstVisibleTab} from './lib/module-visibility';
import {ModuleVisibilityLink} from './module-visibility-link';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ManualAlexaVocNormalizedRecord } from "../shared/agent-contracts";
import { AuthIdentityControl, AuthSessionGate, type AuthenticatedWebSession } from "./auth-session-gate";
import { ConcurrencyAdminPanel } from "./concurrency-admin-panel";
import { HelpFeedbackDrawer } from "./help-feedback/help-feedback-drawer";
import {
  isPrimaryAdministrator,
  shouldShowBuilderNotice,
  type BuilderNotice,
} from "./lib/primary-admin";
import {
  sifListingTrafficMeta,
  trafficDisplayFromSnapshot,
  type TrafficDisplayData,
} from "./sif-listing-traffic-data";
import { sorftimeReviewAnalysisMeta } from "./seller-sprite-review-analysis";
import {TrafficReportView} from "./project-report-views/traffic";
export {TrafficAnalysisConclusionSection} from "./project-report-views/traffic";
import { ReviewAnalysisMatrixSection, VocSevenDimensionInsightSection, ManualVocMatrixSection, VocOverviewIntroduction } from "./project-report-views/voc";
export { ReviewAnalysisMatrixSection } from "./project-report-views/voc";
import { sorftimeReviewAnalysisMeta as sorftimeReviewDataMeta, type sorftimeReviewAnalysisData } from "./sorftime-review-analysis-data";
import { ProductLaunchRecommendationSection } from "./product-launch-recommendation";
import { VocPositioningSection } from "./voc-positioning-section";
import { LocalVocDefinition } from "./local-voc-definition";
import { VocEvidenceDefinition } from "./voc-evidence-definition";
import "./voc-evidence-definition.css";
import { LaunchChecklistSection } from "./launch-checklist-section";
import type { ProductLaunchRuntimeSources } from "./product-launch-analysis";
import { KeywordDemandSection } from "./keyword-demand-section";
import { buildKeywordDemandAnalysis } from "./keyword-demand-analysis";
import { AlexaVocImportPanel } from "./alexa-voc-import-panel";
import { useManualAlexaVoc } from "./use-manual-alexa-voc";
import { AsinSyncProgressSection, hasResumableFailedStages, UrlResumableAsinSyncFunnel, type StageOutputSnapshot, type SyncCompletionDisposition, type SyncJob, type SyncResumeBundle } from "./asin-sync-funnel";
import { createIncompleteSyncRepair } from "./lib/sync-incomplete-repair-browser";
import { BatchAsinInput } from "./batch-asin-input";
import { KeywordFetchStatusSection } from "./keyword-fetch-status";
import type { sifKeywordAnalysisData } from "./sif-keyword-analysis-data";
import type { sifKeywordEnrichmentData } from "./sif-keyword-enrichment-data";
import { TrafficFetchStatusSection } from "./traffic-fetch-status";
import { TrafficDetailRecoveryControl } from './traffic-detail-recovery';
import type { sorftimeCategoryTrendData } from "./sorftime-category-trend-data";
import { LISTING_IMAGES_SOURCE_LABEL, ListingImagesSection } from "./listing-images-section";
import type { listingImageRemarks } from "./listing-image-remarks";
import { projectSegmentName } from "../shared/project-segment-name";
import { ProjectLibraryPage, type AnalysisProject } from "./project-library-panel";
import { useAnalysisProjectFavorites } from "./use-analysis-project-favorites";
import { AnalysisProjectFavoriteButton } from "./analysis-project-favorite-button";
import { inferAmazonMajorCategory } from "./amazon-major-categories";
import { amazonMediaSrc } from "./lib/amazon-image";
import { localAgentErrorMessage, localAgentFetch } from "./lib/local-agent-browser";
import { buildAppTabHref as buildTabHref, tabFromParam, type TabId } from "./lib/app-tabs";
import {MarketSiteSchema} from "../shared/market-sites";
import { marketNavigation, marketScreenFromParam, marketViewHref, type MarketScreen } from "./lib/market-navigation";
import { MarketResearchSection } from "./market-research-section";
import "./market-research.css";
import {
  buildSavedAnalysisReportView,
  readSavedAnalysisReport,
  serializeSavedAnalysisReportView,
  type SavedAnalysisReportSelection,
} from "./lib/saved-analysis-reports";
import {
  baseSyncRunIdFromSearch,
  cancelVocRun,
  clearVocRunFromSearch,
  observeVocRun,
  retryVocStage,
  vocRunIdFromSearch,
  waitForVocRun,
  VocRunClientError,
  type VocRunObservation,
} from "./lib/voc-run-browser";
import { projectWorkspacePath, workspaceHref } from "./lib/workspace-url";
import { WorkspaceHistoryStrip } from "./workspace-history-strip";
import { clearSyncJobFromSearch, isSyncJobScopeMatch, searchWithSyncJobId, syncJobIdFromSearch } from "./lib/asin-sync-session";
import { parseBatchAsinInput } from "./lib/asin-batch-input";
import { createTrafficSnapshotOwner, trafficSnapshotBindingKey, type TrafficSnapshotClientState } from "./lib/traffic-snapshot-browser";
import { trafficStageFromReceipt, type TrafficStageReceipt } from "./lib/traffic-detail-view";
import { publicationArtifactNotice } from "./lib/publication-artifact-notice";
import { useResumedSyncScope } from "./lib/resumed-sync-scope";
import { resolveAlexaVocPageScope } from "./lib/alexa-voc-page-scope";
import { browserSessionStorage, createTerminalSyncOwner } from "./lib/sync-terminal-owner";
import { buildStageOutputView } from "./lib/stage-output-view";
import { useVocReviewOutput } from "./lib/use-voc-review-output";
import { scopedReviewRecords, reviewMissingMessage } from "./lib/voc-review-display";
import { createRuntimeAnalysisScopeGuard, readAndCommitRuntimeAnalysisData, type RuntimeAnalysisDataSnapshot } from "./lib/runtime-analysis-data";
import { useXydcOrderProgress } from "./lib/use-xydc-order-progress";
import { StageOutputGapCard } from "./stage-output-gap-card";
import { StageOutputGapNotice, stageOutputGapReasonCode } from "./stage-output-gap-notice";
import type { sorftimeListingContentData } from "./sorftime-listing-content-data";
import { CatalogSourceStatus, type CatalogSource } from "./catalog-source-status";
import { useSidebarCollapse } from "./lib/sidebar-preference";
import { SidebarCollapseToggle } from "./sidebar-collapse-toggle";
import { XydcVariantSection } from "./xydc-variant-section";

function currentWebArtifactId(): string {
  return document.documentElement.dataset.webArtifactId ?? "legacy";
}

const ROOT_PATH_DIAGNOSTIC =
  "根路径不再混合展示全部底库。请输入一批同类 ASIN，或点下方工作区进入 /p/floor-lamps、/p/kick-scooters";
const RUNTIME_ANALYSIS_REFRESH_FAILED = "最新分析数据暂未刷新，页面已保留现有结果";

type RuntimeAnalysisRefreshResult =
  | Readonly<{ ok: true; snapshot: RuntimeAnalysisDataSnapshot }>
  | Readonly<{ ok: false; reason: "failed" | "superseded"; message: string }>;

type Keyword = { word: string; share: number; type: "自然" | "广告" };
type VariantDetail = { name: string; reviews: number | null; share: number | null; launch: string | null };
type NavGroupId = "market-group" | "overview-group" | "voc-group" | "keywords-group" | "projects-group";

const savedReportStageLabels = {
  "traffic-analysis": "流量分析",
  "voc-positioning": "VOC 定位",
  "product-definition": "产品定义",
} as const;

type NavLeaf = { id: TabId; label: string; sub: string; marketView?: MarketScreen };
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

function isOverviewFamilyTab(tabId: TabId) {
  return tabId === "overview" || tabId === "overview-images";
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
  if (tabId === "market-overview") return "market-group";
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
  "market-group": "insight",
  "market-overview": "traffic",
  "market-structure": "params",
  "market-traffic": "ads",
  "market-review-insight": "review",
  "overview-group": "overview",
  overview: "params",
  "overview-images": "gallery",
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
const PROJECT_REGISTRATION_FAILURE = "项目登记失败，未创建分析任务，请重试";

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

function replaceAppUrl(params: URLSearchParams | string, basePath = "/") {
  if (typeof window === "undefined") return;
  const query = params.toString();
  const url = query ? `${basePath}?${query}` : basePath;
  window.history.replaceState(window.history.state, "", url);
}

function buildProjectLoadHref(
  project: AnalysisProject,
  current: URLSearchParams | { toString(): string },
  tabId: TabId = "overview",
) {
  let params = new URLSearchParams(current.toString());
  if (tabId === "overview") params.delete("tab");
  else params.set("tab", tabId);
  params.delete("asins");
  params.delete("project");
  params.delete("run");
  params = clearVocRunFromSearch(params);
  params.delete("syncJob");
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

function catalogSourceTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function SourceBadge({ children }: { children: React.ReactNode }) {
  return <span className="source-badge">{children}</span>;
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

export function VocRunStatusSummary({ observation }: { observation: VocRunObservation | null }) {
  if (!observation) {
    return null;
  }
  const stage = observation.stage;
  const stageStatus = typeof stage?.status === "string" ? stage.status.trim() : "";
  const queueTimeout = (stage?.lastError as { code?: string } | null)?.code === "QUEUE_TIMEOUT";

  return <>
    <strong>VOC Agent · {queueTimeout ? "排队超时" : observation.kind}</strong>
    <p>{observation.message}</p>
    {observation.runId ? <small>Run {observation.runId}</small> : null}
    {stage && stageStatus ? <>
      <p>
        {queueTimeout ? "阶段：已失败" : `Stage: ${stageStatus}`} · {String(stage.progress ?? 0)}%
      </p>
      {stage.lastError && !queueTimeout ? (
        <p>{typeof stage.lastError === "object" && "message" in stage.lastError
          ? String(stage.lastError.message)
          : String(stage.lastError)}</p>
      ) : null}
    </> : null}
  </>;
}

export function AuthenticatedAmazonOpportunityApp({ authSession }: { authSession: AuthenticatedWebSession }) {
  const params=useSearchParams(),pathname=usePathname(),router=useRouter();
  const requested=tabFromParam(params.get('tab'));
  const allowed=canSeeTab(authSession.visibleModules,requested);
  const fallback=firstVisibleTab(authSession.visibleModules);
  const href=fallback?buildTabHref(fallback,params,pathname):null;
  useEffect(()=>{if(!allowed&&href)router.replace(href)},[allowed,href,router]);
  if(!allowed)return <main className="auth-session-shell"><section className="auth-login-card"><h1>{fallback?'正在打开可见模块':'暂无可见模块'}</h1><p>{fallback?'当前模块未设置为显示。':'请联系管理员设置需要显示的模块。'}</p><AuthIdentityControl session={authSession}/></section></main>;
  return <VisibleAmazonOpportunityApp authSession={authSession}/>;
}

function VisibleAmazonOpportunityApp({ authSession }: { authSession: AuthenticatedWebSession }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const appSearch = searchParams.toString();
  const appLocationRef = useRef({ pathname, search: appSearch });
  useEffect(() => {
    appLocationRef.current = { pathname, search: appSearch };
  }, [appSearch, pathname]);
  const tabParam = searchParams.get("tab");
  const asinsParam = searchParams.get("asins");
  const projectParam = searchParams.get("project");
  const slugParam = pathname.match(/^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)$/)?.[1] ?? null;
  const workspacePath = slugParam ? `/p/${slugParam}` : "/";
  const tabHref = (tabId: TabId) => buildTabHref(tabId, searchParams, workspacePath);
  const initialAsins = resolveActiveAsins(slugParam ? null : asinsParam);
  const activeTab = tabFromParam(tabParam);
  const activeMarketSite=MarketSiteSchema.safeParse(searchParams.get("marketSite")).data??"US";
  const activeMarketView = marketScreenFromParam(searchParams.get("themeView"));
  const isLeafActive = (leaf: NavLeaf) => leaf.id === activeTab && (!leaf.marketView || leaf.marketView === activeMarketView);
  const leafHref = (leaf: NavLeaf) => leaf.marketView ? marketViewHref(leaf.marketView, searchParams) : tabHref(leaf.id);
  useEffect(()=>{if(activeTab!=="market-overview")publishUsagePage(activeTab)},[activeTab]);
  const [market, setMarket] = useState<MarketCode>("US");
  const [inputs, setInputs] = useState(() => buildInputSlots(initialAsins));
  const [asinDraft, setAsinDraft] = useState(() => initialAsins.join("\n"));
  const asinParse = useMemo(() => parseBatchAsinInput(asinDraft), [asinDraft]);
  const replaceInputAsins = useCallback((asins: string[]) => {
    setInputs(buildInputSlots(asins));
    setAsinDraft(asins.join("\n"));
  }, []);
  const [activeAsins, setActiveAsins] = useState(initialAsins);
  const [salesView, setSalesView] = useState<"history" | "revenue" | "prices" | "ranks">("history");
  const [builderNotice, setBuilderNotice] = useState<BuilderNotice>(() =>
    slugParam
      ? { kind: "business", text: `正在打开工作区 /p/${slugParam}` }
      : { kind: "path-diagnostic", text: ROOT_PATH_DIAGNOSTIC },
  );
  const setMessage = useCallback((text: string) => {
    setBuilderNotice({ kind: "business", text });
  }, []);
  const message = builderNotice.text;
  const showBuilderNotice = shouldShowBuilderNotice(builderNotice, authSession.user);
  const [vocRun, setVocRun] = useState<VocRunObservation | null>(null);
  const [selectedReportIds, setSelectedReportIds] = useState<SavedAnalysisReportSelection>({});
  const restoringVocRun = useRef<string | null>(null);
  const vocRestoreController = useRef<AbortController | null>(null);
  const [syncAsins, setSyncAsins] = useState<string[] | null>(null);
  const [syncRunContext, setSyncRunContext] = useState<{ projectId: string; runId: string } | null>(null);
  const [terminalSyncJob, setTerminalSyncJob] = useState<SyncJob | null>(null);
  const [publicationConvergenceNotice, setPublicationConvergenceNotice] = useState<string | null>(null);
  const [stageOutputReceipt, setStageOutputReceipt] = useState<(TrafficStageReceipt & { ownerToken: object }) | null>(null);
  const [terminalPointerRetained, setTerminalPointerRetained] = useState(false);
  const [terminalRepairPending, setTerminalRepairPending] = useState(false);
  const terminalRepairInFlight = useRef(false);
  const terminalRepair = useRef(createIncompleteSyncRepair(localAgentFetch));
  const terminalRepairScope = useRef(createRuntimeAnalysisScopeGuard());
  const analysisStartInFlight = useRef(false);
  const workspaceKey = slugParam || projectParam;
  const [hydratedWorkspaceKey, setHydratedWorkspaceKey] = useState<string | null>(workspaceKey ? null : "");
  const syncSuppressedKey = useRef<string | null>(null);
  const autoSyncStartedKey = useRef<string | null>(null);
  const [syncSessionJobIds, setSyncSessionJobIds] = useState<Set<string>>(() => new Set());
  const rememberSyncJob = useCallback((jobId: string) => {
    setSyncSessionJobIds(current => {
      if (current.has(jobId)) return current;
      const next = new Set(current);
      next.add(jobId);
      return next;
    });
  }, []);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(projectParam);
  const [currentProjectName, setCurrentProjectName] = useState<string | null>(null);
  const [reportProject, setReportProject] = useState<Pick<AnalysisProject, "id" | "kind"> | null>(null);
  const [imageProjectContext,setImageProjectContext] = useState<{projectId:string;kind:string}|null>(null);
  const [savingKeywordCompare, setSavingKeywordCompare] = useState(false);
  const [savingTrafficPromo, setSavingTrafficPromo] = useState(false);
  const [savingChecklist, setSavingChecklist] = useState(false);
  const [refreshingProjectId, setRefreshingProjectId] = useState<string | null>(null);
  const [flyoutGroupId, setFlyoutGroupId] = useState<NavGroupId | null>(null);
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapse();
  const [flyoutPinned, setFlyoutPinned] = useState(false);
  const [flyoutTop, setFlyoutTop] = useState(96);
  const flyoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flyoutPanelRef = useRef<HTMLElement | null>(null);
  const flyoutPinnedRef = useRef(false);
  const [catalogItems, setCatalogItems] = useState<Product[]>([]);
  const [runtimeAnalysisData, setRuntimeAnalysisData] = useState<RuntimeAnalysisDataSnapshot | null>(null);
  const [runtimeAnalysisDataScope, setRuntimeAnalysisDataScope] = useState<string | null>(null);
  const runtimeAnalysisRequest = useRef(0);
  const runtimeCommitGuard = useRef(createRuntimeAnalysisScopeGuard());
  const syncJobId = syncJobIdFromSearch(searchParams.toString());
  const baseSyncRunId = baseSyncRunIdFromSearch(searchParams.toString());
  const runtimeSessionKey = `${authSession.sessionIdentity}:${authSession.user.organizationId}`;
  const projectFavorites = useAnalysisProjectFavorites(authSession.logoutPending ? null : runtimeSessionKey);
  useLayoutEffect(() => {
    setVocRun(null);
    return () => {
      vocRestoreController.current?.abort();
      vocRestoreController.current = null;
      restoringVocRun.current = null;
    };
  }, [runtimeSessionKey, authSession.logoutPending]);
  const runtimeAsinKey = [...activeAsins].sort().join(",");
  const runtimeScopeKey = `${runtimeSessionKey}:${currentProjectId}:${market}:${runtimeAsinKey}:${syncJobId}:${baseSyncRunId}`;
  const runtimeScope = useRef<{ sessionKey: string; projectId: string | null; asins: string; enabled: boolean } | null>(null);
  useLayoutEffect(() => {
    const guard = runtimeCommitGuard.current;
    guard.activate(authSession.logoutPending ? null : runtimeScopeKey);
    runtimeScope.current = { sessionKey: runtimeSessionKey, projectId: currentProjectId, asins: runtimeAsinKey, enabled: !authSession.logoutPending };
    return () => { runtimeScope.current = null; guard.activate(null); };
  }, [runtimeSessionKey, runtimeScopeKey, currentProjectId, runtimeAsinKey, authSession.logoutPending]);
  const refreshRuntimeAnalysisData = useCallback(async (
    projectId: string,
    asins: readonly string[],
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<RuntimeAnalysisRefreshResult> => {
    const request = ++runtimeAnalysisRequest.current;
    const captured = runtimeCommitGuard.current.capture();
    const sessionKey = runtimeScope.current?.sessionKey;
    const asinKey = [...asins].sort().join(",");
    try {
      const snapshot = await readAndCommitRuntimeAnalysisData(projectId, asins, {
        signal,
        isCurrent: () => runtimeCommitGuard.current.isCurrent(captured) && request === runtimeAnalysisRequest.current && (!isCurrent || isCurrent())
          && runtimeScope.current?.enabled === true && runtimeScope.current.sessionKey === sessionKey
          && runtimeScope.current.projectId === projectId && runtimeScope.current.asins === asinKey,
        commit: snapshot => { setRuntimeAnalysisData(snapshot); setRuntimeAnalysisDataScope(captured!.key); setCatalogItems(snapshot.catalog as Product[]); },
      });
      if (!snapshot) {
        return { ok: false, reason: "superseded", message: RUNTIME_ANALYSIS_REFRESH_FAILED };
      }
      return { ok: true, snapshot };
    } catch {
      return {
        ok: false,
        reason: request === runtimeAnalysisRequest.current ? "failed" : "superseded",
        message: RUNTIME_ANALYSIS_REFRESH_FAILED,
      };
    }
  }, []);
  const refreshRuntimeAfterSync = useCallback(async (successMessage: string): Promise<boolean> => {
    if (!currentProjectId) {
      setMessage(RUNTIME_ANALYSIS_REFRESH_FAILED);
      return false;
    }
    const result = await refreshRuntimeAnalysisData(currentProjectId, activeAsins);
    if (!result.ok) {
      if (result.reason === "failed") setMessage(result.message);
      return false;
    }
    setMessage(successMessage);
    return true;
  }, [activeAsins, currentProjectId, refreshRuntimeAnalysisData, setMessage]);
  const [workspaces, setWorkspaces] = useState<AnalysisProject[]>([]);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const resumedSyncScope = useResumedSyncScope({
    runId: baseSyncRunId,
    fallbackContext: syncRunContext,
  });
  const workspaceReady = !workspaceKey || hydratedWorkspaceKey === workspaceKey;
  const refreshXydcProgress = useCallback(async (signal: AbortSignal, isCurrent: () => boolean) => {
    if (!currentProjectId) return undefined;
    const result = await refreshRuntimeAnalysisData(currentProjectId, activeAsins, signal, isCurrent);
    if (!result.ok && result.reason === "failed" && !signal.aborted && isCurrent()) setMessage(result.message);
    return result.ok ? result.snapshot.xydcOrderProgress : undefined;
  }, [currentProjectId, activeAsins, refreshRuntimeAnalysisData, setMessage]);
  useXydcOrderProgress({
    scopeKey: runtimeScopeKey,
    enabled: workspaceReady && Boolean(currentProjectId) && !authSession.logoutPending,
    view: runtimeAnalysisDataScope === runtimeScopeKey ? runtimeAnalysisData?.xydcOrderProgress ?? null : null,
    refresh: refreshXydcProgress,
  });
  const alexaVocPageScope = resolveAlexaVocPageScope({
    currentProjectId,
    workspaceReady,
    resumedSyncScope,
  });
  const resumedProjectId = resumedSyncScope.context?.projectId ?? (baseSyncRunId ? null : currentProjectId);
  const displayVersionScopeKey = `${runtimeSessionKey}:${currentProjectId}:${market}:${runtimeAsinKey}`;
  const [displayVersionReceipt, setDisplayVersionReceipt] = useState<{
    scopeKey: string;
    version: CurrentProjectDisplayVersion | null;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (!workspaceReady || !currentProjectId || !activeAsins.length || authSession.logoutPending) return;
    let cancelled = false;
    void readCurrentProjectDisplayVersion({
      organizationId: authSession.user.organizationId,
      projectId: currentProjectId,
      marketplace: market,
      asins: activeAsins,
    }).then(version => {
      if (!cancelled) setDisplayVersionReceipt({ scopeKey: displayVersionScopeKey, version, failed: false });
    }).catch(() => {
      if (!cancelled) {
        setDisplayVersionReceipt({ scopeKey: displayVersionScopeKey, version: null, failed: true });
        setMessage("当前报告读取失败，请刷新后重试");
      }
    });
    return () => { cancelled = true; };
  }, [workspaceReady, currentProjectId, market, runtimeAsinKey, runtimeSessionKey,
    authSession.logoutPending, authSession.user.organizationId, terminalSyncJob?.jobId,
    displayVersionScopeKey, setMessage]);
  const currentDisplayVersion = displayVersionReceipt?.scopeKey === displayVersionScopeKey
    ? displayVersionReceipt.version : null;
  const catalogMissingCount = currentDisplayVersion
    ? new Set(currentDisplayVersion.gaps.filter(gap => gap.field === "catalog").map(gap => gap.asin)).size : 0;
  const catalogUnverifiedCount = currentDisplayVersion
    ? new Set(currentDisplayVersion.gaps.filter(gap => gap.field === "catalog.sellerSprite").map(gap => gap.asin)).size : 0;
  const catalogStatusLabel = [
    ...(catalogMissingCount ? [`${catalogMissingCount} 个 ASIN 目录结果缺失`] : []),
    ...(catalogUnverifiedCount ? [`${catalogUnverifiedCount} 个 ASIN 目录未验证（上游空值）`] : []),
  ].join(" · ");
  const catalogSourceLabel = currentDisplayVersion?.catalogEvidence
    ? `目录文件 ${catalogSourceTime(currentDisplayVersion.catalogEvidence.sourceUpdatedAt)}（北京时间） · ${currentDisplayVersion.catalogEvidence.sourceJobId
        ? `来源任务 ${currentDisplayVersion.catalogEvidence.sourceJobId.slice(0, 8)}` : "来源任务未关联"}`
    : currentDisplayVersion ? "目录来源待核验" : "卖家精灵更新 2026-08-03";
  const displayVersionReadFailed = displayVersionReceipt?.scopeKey === displayVersionScopeKey
    && displayVersionReceipt.failed;
  const displayVersionPending = Boolean(currentProjectId && !authSession.logoutPending
    && (!workspaceReady || displayVersionReceipt?.scopeKey !== displayVersionScopeKey));
  const displayVersionMissing = Boolean(currentProjectId && reportProject?.id === currentProjectId
    && (!reportProject.kind || reportProject.kind === "analysis") && !authSession.logoutPending
    && displayVersionReceipt?.scopeKey === displayVersionScopeKey
    && !displayVersionReceipt.failed && !displayVersionReceipt.version);
  useLayoutEffect(() => {
    const guard = terminalRepairScope.current;
    guard.activate(workspaceReady && !authSession.logoutPending && resumedSyncScope.canAdopt
      ? `${runtimeScopeKey}:${workspacePath}:${market}:${resumedProjectId}` : null);
    return () => guard.activate(null);
  }, [runtimeScopeKey, workspacePath, market, resumedProjectId, workspaceReady, authSession.logoutPending, resumedSyncScope.canAdopt]);
  const terminalOwnerFor = useCallback((values: string[], options?: { projectId?: string | null; marketplace?: string }) => createTerminalSyncOwner({
    storage: browserSessionStorage(),
    pathname: workspacePath,
    organizationId: authSession.user.organizationId,
    projectId: options?.projectId ?? resumedProjectId,
    marketplace: options?.marketplace ?? market,
    asins: values,
  }), [authSession.user.organizationId, market, resumedProjectId, workspacePath]);
  const dismissSyncJob = useCallback(() => {
    if (terminalPointerRetained) return;
    syncSuppressedKey.current = activeAsins.join(",");
    autoSyncStartedKey.current = null;
    setSyncAsins(null);
    setTerminalSyncJob(null);
    setRefreshingProjectId(null);
    replaceAppUrl(clearSyncJobFromSearch(window.location.search), window.location.pathname);
  }, [activeAsins, terminalPointerRetained]);
  const restartTerminalSync = useCallback(async (parentJob: SyncJob, imageAction?: {asin:string;action:"refresh"|"analyze"}) => {
    if (terminalRepairInFlight.current || !workspaceReady || !resumedSyncScope.canAdopt || !resumedProjectId || authSession.logoutPending) {
      if (imageAction) throw new Error("当前项目正在切换或提交任务，请稍后重试");
      return;
    }
    const captured = terminalRepairScope.current.capture();
    const isCurrent = () => terminalRepairScope.current.isCurrent(captured);
    terminalRepairInFlight.current = true;
    setTerminalRepairPending(true);
    try {
      const result = await terminalRepair.current({ asins: activeAsins, marketplace: market, projectId: resumedProjectId, parentJobId: parentJob.jobId, ...(imageAction ? {imageAction} : {}) }, isCurrent);
      if (!result || !isCurrent()) return;
      if ("noWork" in result) {
        setMessage(result.message);
        return;
      }
      terminalOwnerFor(activeAsins).clearForExplicitStart();
      syncSuppressedKey.current = null;
      autoSyncStartedKey.current = activeAsins.join(",");
      rememberSyncJob(result.jobId);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setSyncAsins(null);
      setSyncRunContext(result.scope);
      restoringVocRun.current = null;
      setVocRun(null);
      setSelectedReportIds({});
      const params = clearVocRunFromSearch(new URLSearchParams(searchWithSyncJobId(window.location.search, result.jobId)));
      params.set("run", result.scope.runId);
      replaceAppUrl(params, window.location.pathname);
      setMessage(imageAction ? `${imageAction.asin} · ${imageAction.action === "refresh" ? "重新抓取并重新分析" : "重新分析"}已排队` : "补抓未完成数据已启动");
      return result.jobId;
    } catch (error) {
      if (isCurrent()) setMessage(error instanceof Error ? error.message : "补抓启动失败");
      if (imageAction) throw error;
    } finally {
      terminalRepairInFlight.current = false;
      setTerminalRepairPending(false);
    }
  }, [activeAsins, authSession.logoutPending, market, rememberSyncJob, resumedProjectId, resumedSyncScope.canAdopt, setMessage, terminalOwnerFor, workspaceReady]);
  const handleTerminalSyncJob = useCallback((job: SyncJob): SyncCompletionDisposition => {
    const resumable = hasResumableFailedStages(job);
    const terminalOwner = terminalOwnerFor(job.asins ?? activeAsins, {
      projectId: job.scope?.projectId ?? resumedSyncScope.context?.projectId ?? null,
      marketplace: job.marketplace ?? market,
    });
    const applied = job.publication?.status === "applied" ? job.publication : null;
    const artifactId = applied?.artifactId ?? null;
    const recorded = terminalOwner.recordTerminal({ jobId: job.jobId, artifactId });
    const recordedArtifactId = recorded ? terminalOwner.readTerminal()?.artifactId ?? null : null;
    const convergentArtifact = applied && recordedArtifactId === applied.artifactId ? applied : null;
    setTerminalPointerRetained(resumable || !recorded);
    setSyncAsins(null);
    setTerminalSyncJob(job);
    setRefreshingProjectId(null);
    const currentArtifact = currentWebArtifactId();
    let disposition: SyncCompletionDisposition =
      !job.publication || job.publication.status === "not-required"
        ? "settled"
        : "convergence-blocked";
    if (convergentArtifact && currentArtifact === convergentArtifact.artifactId) {
      const url = new URL(window.location.href);
      if (url.searchParams.has("webArtifact")) {
        url.searchParams.delete("webArtifact");
        window.history.replaceState(window.history.state, "", url.toString());
      }
      setPublicationConvergenceNotice(null);
      disposition = "settled";
    } else if (convergentArtifact && terminalOwner.claimArtifactReload({ jobId: job.jobId, artifactId: convergentArtifact.artifactId })) {
      setPublicationConvergenceNotice(null);
      const url = new URL(window.location.href);
      url.searchParams.set("webArtifact", convergentArtifact.artifactId);
      window.location.replace(url.toString());
      return "navigation-started";
    } else {
      setPublicationConvergenceNotice(applied
        ? publicationArtifactNotice(currentArtifact, applied.artifactId)
        : null);
    }
    if (recorded) {
      syncSuppressedKey.current = activeAsins.join(",");
      autoSyncStartedKey.current = null;
    }
    return disposition;
  }, [activeAsins, market, resumedSyncScope.context?.projectId, terminalOwnerFor]);
  const stageOutputJobId = syncJobId ?? terminalSyncJob?.jobId ?? null;
  const runListingImageAction = async (asin:string, action:"refresh"|"analyze") => {
    if (!resumedProjectId || !workspaceReady || !resumedSyncScope.canAdopt) throw new Error("请先加载已同步的项目");
    if (imageProjectContext?.projectId !== currentProjectId || imageProjectContext.kind !== "analysis") throw new Error("当前是收藏视图或项目仍在读取，请先使用上方入口打开来源分析项目");
    const captured = terminalRepairScope.current.capture();
    const pointer = stageOutputJobId ? {jobId:stageOutputJobId} : await readHistoricalSyncPointer({id:resumedProjectId,asins:activeAsins,marketplace:market},{strict:true});
    if (!terminalRepairScope.current.isCurrent(captured)) return;
    if (!pointer) throw new Error("当前分析项目尚无基础同步任务，请先完成基础同步");
    const response=await localAgentFetch(`/v1/local-data/sync-asins/${encodeURIComponent(pointer.jobId)}`);
    const parent=await response.json() as SyncJob;
    if (!terminalRepairScope.current.isCurrent(captured)) return;
    if (!response.ok || parent.jobId!==pointer.jobId || !isSyncJobScopeMatch({asins:parent.asins??[],marketplace:parent.marketplace??"",scope:parent.scope},{asins:activeAsins,marketplace:market,projectId:resumedProjectId,runId:parent.scope?.runId ?? null})) throw new Error("同步记录与当前项目不匹配");
    if (!["completed","completed-with-gaps","failed"].includes(parent.status)) throw new Error("当前项目正在同步，请完成后再处理图片");
    return await restartTerminalSync(parent,{asin,action});
  };
  const stageOutputRunId = baseSyncRunId ?? resumedSyncScope.context?.runId ?? null;
  const stageOutputScopeKey = [
    authSession.sessionIdentity,
    authSession.logoutPending ? "logout" : "active",
    market, [...activeAsins].sort().join(","),
    authSession.user.organizationId,
    workspacePath,
    resumedProjectId ?? "",
    stageOutputRunId ?? "",
    stageOutputJobId ?? "",
  ].join("|");
  // A fresh token prevents A -> B -> A from reviving the first A's pending response.
  const stageOutputOwnerToken = useMemo(() => ({ scopeKey: stageOutputScopeKey }), [stageOutputScopeKey]);
  const onScopedStageOutput = useCallback((snapshot: StageOutputSnapshot, reason?: "owner-disposed") => {
    // Tab disposal is not a new data result. Explicit retry updates (including {}) still apply.
    if (reason === "owner-disposed") return;
    setStageOutputReceipt({ scopeKey: stageOutputOwnerToken.scopeKey, ownerToken: stageOutputOwnerToken, snapshot });
  }, [stageOutputOwnerToken]);
  const [imageJobReceipt, setImageJobReceipt] = useState<{ownerToken: typeof stageOutputOwnerToken; job: SyncJob} | null>(null);
  const onImageJobSnapshot = useCallback((job: SyncJob) => {
    setImageJobReceipt({ownerToken: stageOutputOwnerToken, job});
  }, [stageOutputOwnerToken]);
  const currentImageJob = imageJobReceipt?.ownerToken === stageOutputOwnerToken ? imageJobReceipt.job : null;
  const currentStageReceipt = stageOutputReceipt?.ownerToken === stageOutputOwnerToken ? stageOutputReceipt : null;
  // An unpublished first analysis may show its scoped live output. Historical terminal
  // jobs and workspace-generated data must not stand in for a missing saved report.
  const showUnpublishedProgress = displayVersionMissing
    && (currentImageJob?.status === "queued" || currentImageJob?.status === "running");
  const blockReportResults = displayVersionReadFailed || displayVersionPending
    || (displayVersionMissing && !showUnpublishedProgress);
  const reportReadStatus = displayVersionPending ? "正在读取报告"
    : displayVersionReadFailed ? "报告读取失败"
    : displayVersionMissing ? (showUnpublishedProgress ? "分析进行中" : "暂无分析报告") : null;
  const reviewScope = useMemo(() => !authSession.logoutPending && resumedProjectId && stageOutputRunId && stageOutputJobId ? {
    organizationId: authSession.user.organizationId, projectId: resumedProjectId,
    runId: stageOutputRunId, jobId: stageOutputJobId, marketplace: market, asins: activeAsins,
  } : null, [authSession.logoutPending, authSession.user.organizationId, resumedProjectId, stageOutputRunId, stageOutputJobId, market, activeAsins]);
  // VOC has no funnel. Only read here while that tab owns the review view.
  const { snapshot: pageReviewOutput, refreshFailed: reviewRefreshFailed } = useVocReviewOutput(stageOutputScopeKey, reviewScope, activeTab === "voc", currentStageReceipt?.snapshot.reviews);
  const stageOutputSnapshot = useMemo<StageOutputSnapshot>(() => blockReportResults ? {} : currentDisplayVersion?.stageOutputs
    ?? (!authSession.logoutPending && currentStageReceipt
      ? { ...currentStageReceipt.snapshot, ...(activeTab === "voc" ? { reviews: pageReviewOutput.reviews } : {}) } : pageReviewOutput),
    [currentDisplayVersion, blockReportResults, authSession.logoutPending, currentStageReceipt, pageReviewOutput, activeTab]);
  const visibleTrafficStage = trafficStageFromReceipt(currentStageReceipt, {
    scopeKey: stageOutputScopeKey, projectId: resumedProjectId, runId: stageOutputRunId, jobId: stageOutputJobId,
    enabled: !authSession.logoutPending,
  });
  const syncResume = useMemo<SyncResumeBundle>(() => ({
    organizationId: authSession.logoutPending ? null : authSession.user.organizationId,
    sessionIdentity: authSession.sessionIdentity,
    stageOutputScopeKey,
    syncJobId,
    terminalJob: terminalSyncJob,
    projectId: resumedProjectId,
    runId: resumedSyncScope.context?.runId ?? null,
    resumePending: resumedSyncScope.resolving,
    resumeBlocked: !resumedSyncScope.canAdopt,
    workspaceReady,
    onStageOutput: onScopedStageOutput,
    onSyncJobId: jobId => {
      rememberSyncJob(jobId);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      replaceAppUrl(searchWithSyncJobId(window.location.search, jobId), window.location.pathname);
    },
    knownSessionJobIds: syncSessionJobIds,
    onSyncJobObserved: rememberSyncJob,
    onJobSnapshot: onImageJobSnapshot,
    onDismiss: dismissSyncJob,
    onComplete: handleTerminalSyncJob,
    onTerminal: handleTerminalSyncJob,
    onRestart: restartTerminalSync,
    restartPending: terminalRepairPending,
    canResumeFailedStages: isPrimaryAdministrator(authSession.user),
    allowDismiss: !terminalPointerRetained,
  }), [onImageJobSnapshot, authSession.logoutPending, authSession.sessionIdentity, authSession.user.organizationId, onScopedStageOutput, dismissSyncJob, handleTerminalSyncJob, rememberSyncJob, restartTerminalSync, terminalRepairPending, resumedProjectId, resumedSyncScope.canAdopt, resumedSyncScope.context, resumedSyncScope.resolving, stageOutputScopeKey, syncJobId, syncSessionJobIds, terminalPointerRetained, terminalSyncJob, workspaceReady]);

  const products = useMemo(
    () => activeAsins.map(asin => {
      if (displayVersionReadFailed || displayVersionPending || displayVersionMissing) return placeholderProduct(asin);
      if (!currentDisplayVersion) return catalogItems.find(p => p.asin === asin) ?? placeholderProduct(asin);
      const product = (currentDisplayVersion.catalog as Product[]).find(p => p.asin === asin) ?? placeholderProduct(asin);
      const listing = currentDisplayVersion.stageOutputs.listing;
      const listingByAsin = listing && "data" in listing
        ? (listing.data as Record<string, unknown>).contentByAsin as Record<string, { mainImage?: unknown }> : null;
      const mainImage = listingByAsin?.[asin]?.mainImage;
      return typeof mainImage === "string" ? { ...product, image: mainImage } : product;
    }),
    [activeAsins, catalogItems, currentDisplayVersion, displayVersionReadFailed, displayVersionPending, displayVersionMissing]
  );
  const manualVoc = useManualAlexaVoc({
    projectId: alexaVocPageScope.manualListProjectId,
    sessionIdentity: authSession.sessionIdentity,
    organizationId: authSession.user.organizationId,
    marketplace: market,
    asins: activeAsins,
    enabled: !authSession.logoutPending,
  });
  const manualVocByAsin = useMemo<Readonly<Record<string, ManualAlexaVocNormalizedRecord | undefined>>>(
    () => Object.fromEntries(activeAsins.map(asin => [asin, manualVoc.effectiveVocByAsin[asin]?.normalizedRecord])),
    [activeAsins, manualVoc.effectiveVocByAsin],
  );
  const manualVocSourceVersion = JSON.stringify(activeAsins.map(asin => {
    const record = manualVoc.effectiveVocByAsin[asin];
    return [asin, record?.revision ?? null, record?.contentHash ?? null];
  }));
  const [trafficSnapshotReceipt, setTrafficSnapshotReceipt] = useState<{ key: string; state: TrafficSnapshotClientState } | null>(null);
  const trafficBindingKey = trafficSnapshotBindingKey({
    sessionIdentity: authSession.sessionIdentity, organizationId: authSession.user.organizationId,
    logoutPending: authSession.logoutPending, marketplace: market, asins: activeAsins,
    runId: activeTab === "traffic" ? baseSyncRunId : null,
  });
  const trafficSnapshotState = useMemo<TrafficSnapshotClientState>(() => !authSession.logoutPending && trafficSnapshotReceipt?.key === trafficBindingKey
    ? trafficSnapshotReceipt.state : { kind: "pending" }, [authSession.logoutPending, trafficBindingKey, trafficSnapshotReceipt]);
  const trafficSnapshotOwner = useRef<ReturnType<typeof createTrafficSnapshotOwner> | null>(null);
  const asinScopeKey = activeAsins.join(",");
  useLayoutEffect(() => {
    const owner = trafficSnapshotOwner.current ??= createTrafficSnapshotOwner({
      sessionIdentity: authSession.sessionIdentity,
      organizationId: authSession.user.organizationId,
      logoutPending: authSession.logoutPending,
      runId: null,
      marketplace: market,
      asins: activeAsins,
      request: (path) => localAgentFetch(path),
      onState: (state, key) => setTrafficSnapshotReceipt({ state, key }),
    });
    if (activeTab !== "traffic" || !baseSyncRunId || activeAsins.length === 0) {
      owner.rebind({ sessionIdentity: authSession.sessionIdentity, organizationId: authSession.user.organizationId, logoutPending: authSession.logoutPending, runId: null, marketplace: market, asins: activeAsins });
      return;
    }
    owner.rebind({ sessionIdentity: authSession.sessionIdentity, organizationId: authSession.user.organizationId, logoutPending: authSession.logoutPending, runId: baseSyncRunId, marketplace: market, asins: activeAsins });
    void owner.refresh().catch(() => undefined);
    const timer = window.setInterval(() => void owner.refresh().catch(() => undefined), 5_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [activeAsins, activeTab, asinScopeKey, authSession.logoutPending, authSession.sessionIdentity, authSession.user.organizationId, baseSyncRunId, market]);
  // Stage output is independently authorized, not proof for hydrating a snapshot cache.
  const trafficData = useMemo(
    () => trafficSnapshotState.kind === "dynamic" ? trafficDisplayFromSnapshot(trafficSnapshotState.snapshot) : undefined,
    [trafficSnapshotState],
  );
  const trafficOrigin = trafficSnapshotState.kind === "dynamic"
    ? "dynamic" as const
    : trafficSnapshotState.kind === "legacy" ? "legacy" as const : "pending" as const;
  const scopedRuntimeAnalysisData = runtimeAnalysisDataScope === runtimeScopeKey ? runtimeAnalysisData : null;
  const stageOutputView = useMemo(
    () => buildStageOutputView({ ...stageOutputSnapshot, traffic: currentDisplayVersion || blockReportResults
      ? stageOutputSnapshot.traffic : visibleTrafficStage.traffic }, {
      keywordAnalysisByAsin: scopedRuntimeAnalysisData?.keywords.analysisByAsin as typeof sifKeywordAnalysisData ?? {},
      keywordEnrichmentByKeyword: scopedRuntimeAnalysisData?.keywords.enrichmentByKeyword as typeof sifKeywordEnrichmentData ?? {},
      // Global generated review files carry no project/run/job ownership.
      reviewAnalysisByAsin: {} as typeof sorftimeReviewAnalysisData,
      ratingByAsin: scopedRuntimeAnalysisData?.reviews.ratingByAsin as typeof sorftimeRatingData ?? {},
      salesTrendByAsin: scopedRuntimeAnalysisData?.salesTrend.trendByAsin as typeof sorftimeSalesTrendData ?? {},
      fbaFeeByAsin: scopedRuntimeAnalysisData?.fba.feeByAsin as typeof sorftimeFbaFeeData ?? {},
      listingContentByAsin: scopedRuntimeAnalysisData?.listing.contentByAsin as typeof sorftimeListingContentData ?? {},
      categoryTrendByNode: scopedRuntimeAnalysisData?.category.trendByNode as typeof sorftimeCategoryTrendData ?? {},
      childSalesByAsin: scopedRuntimeAnalysisData?.childSales.rowsByAsin as typeof sorftimeChildSales30d ?? {},
      priceStrategyByAsin: scopedRuntimeAnalysisData?.priceStrategy.strategyByAsin as typeof sorftimePriceStrategies ?? {},
      imageRemarksByAsin: scopedRuntimeAnalysisData?.imageRemarks.remarksByAsin as typeof listingImageRemarks ?? {},
      imageRemarkOutcomesByAsin: scopedRuntimeAnalysisData?.imageRemarks.outcomesByAsin ?? {},
      trafficData: trafficData ?? {
        overview: {},
        monthlyTrend: {},
        meta: sifListingTrafficMeta,
      },
    }, { authoritative: Boolean(displayVersionPending || displayVersionReadFailed || displayVersionMissing || currentDisplayVersion || (stageOutputJobId && resumedProjectId === priorityRecoveryProjectId)) }),
    [scopedRuntimeAnalysisData, stageOutputSnapshot, visibleTrafficStage.traffic, trafficData, stageOutputJobId, resumedProjectId, currentDisplayVersion, displayVersionReadFailed, displayVersionPending, displayVersionMissing, blockReportResults],
  );
  const {
    keywordAnalysisByAsin, keywordEnrichmentByKeyword, ratingByAsin,
    salesTrendByAsin, fbaFeeByAsin, listingContentByAsin, categoryTrendByNode,
    childSalesByAsin, priceStrategyByAsin, imageRemarksByAsin, imageRemarkOutcomesByAsin,
  } = stageOutputView;
  const reviewAnalysisByAsin = useMemo(() => scopedReviewRecords(stageOutputView.reviewAnalysisByAsin, activeAsins, market), [stageOutputView.reviewAnalysisByAsin, activeAsins, market]);
  const reviewContexts = useMemo(() => scopedReviewContexts(stageOutputView.reviewContextByAsin, {
    organizationId: authSession.user.organizationId, projectId: currentProjectId ?? '', marketplace: market, asins: activeAsins,
  }), [stageOutputView.reviewContextByAsin, authSession.user.organizationId, currentProjectId, market, activeAsins]);
  const reviewGapReasonCode = stageOutputGapReasonCode(stageOutputSnapshot.reviews);
  const productLaunchSources = useMemo<ProductLaunchRuntimeSources>(() => ({
    analysisScope: { organizationId: authSession.user.organizationId, projectId: resumedProjectId ?? workspacePath, marketplace: market },
    manualVocByAsin,
    keywordSources: { analysisByAsin: keywordAnalysisByAsin, enrichmentByKeyword: keywordEnrichmentByKeyword },
    reviewFallbackCandidates: reviewAnalysisByAsin,
    keywordDemand: buildKeywordDemandAnalysis(
      products.map(product => ({
        asin: product.asin,
        brand: product.brand,
        title: product.title,
        subRankCategory: product.subRankCategory,
        image: product.image,
        price: product.price,
      })),
      {
        analysisByAsin: keywordAnalysisByAsin,
        enrichmentByKeyword: keywordEnrichmentByKeyword,
      },
    ),
  }), [authSession.user.organizationId, resumedProjectId, workspacePath, market, keywordAnalysisByAsin, keywordEnrichmentByKeyword, manualVocByAsin, products, reviewAnalysisByAsin]);
  const mixedFamilies = useMemo(() => {
    const families = new Set(
      products.map(item => item.productFamily).filter((item): item is NonNullable<Product["productFamily"]> => Boolean(item) && item !== "generic"),
    );
    return families.size > 1;
  }, [products]);
  const savedReportView = useMemo(
    () => vocRun?.runId
      ? buildSavedAnalysisReportView(vocRun.runId, vocRun.reports, selectedReportIds)
      : null,
    [selectedReportIds, vocRun],
  );

  const refreshCatalog = useCallback(async () => {
    try {
      const response = await fetch("/api/catalog");
      if (!response.ok) return;
      const payload = (await response.json()) as { items?: Product[] };
      if (Array.isArray(payload.items) && payload.items.length) {
        setCatalogItems(payload.items);
      }
    } catch {
      // 等待运行时目录恢复；不显示代码仓库中的历史目录数据。
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && !workspaceKey) void refreshCatalog();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshCatalog, workspaceKey]);

  useEffect(() => {
    const runId = vocRunIdFromSearch(appSearch);
    if (authSession.logoutPending || !runId || restoringVocRun.current === runId) return;
    restoringVocRun.current = runId;
    const controller = new AbortController();
    vocRestoreController.current = controller;
    void waitForVocRun(runId, { signal: controller.signal, onObservation: (observation) => {
      if (!controller.signal.aborted) setVocRun(observation);
    } })
      .catch((error) => { if (!controller.signal.aborted) setVocRun({
        kind: "failed",
        runId,
        stage: null,
        report: null,
        reports: [],
        message: error instanceof Error ? error.message : "Unable to restore VOC run",
      }); });
    return () => {
      controller.abort();
      if (restoringVocRun.current === runId) restoringVocRun.current = null;
    };
  }, [appSearch, runtimeSessionKey, authSession.logoutPending]);

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
  }, [flyoutGroupId, flyoutTop]);

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
    if (syncJobId) {
      if (!force || !["completed", "completed-with-gaps", "failed"].includes(terminalSyncJob?.status ?? "")) return false;
      replaceAppUrl(clearSyncJobFromSearch(window.location.search), window.location.pathname);
      setTerminalPointerRetained(false);
    }
    if (!resumedSyncScope.canStart) return false;
    if (!workspaceReady) return false;
    if (!force && syncSuppressedKey.current === key) return false;
    const terminalOwner = terminalOwnerFor(values);
    if (!force && terminalOwner.blocksAutomaticStart()) {
      syncSuppressedKey.current = key;
      return false;
    }
    if (!force && autoSyncStartedKey.current === key && syncAsins) return false;

    if (!force) {
      const pendingCatalog = values.filter(v => !catalogItems.some(p => p.asin === v)).length;
      let needsMcpSync = pendingCatalog > 0;
      try {
        const response = await localAgentFetch(`/v1/local-data/sync-asins?asins=${encodeURIComponent(key)}&marketplace=${encodeURIComponent(market)}${currentProjectId ? `&projectId=${encodeURIComponent(currentProjectId)}` : ""}`);
        if (response.ok) {
          const payload = await response.json();
          needsMcpSync = Boolean(payload.needsSync);
        }
      } catch {
        needsMcpSync = pendingCatalog > 0;
      }
      if (!needsMcpSync) return false;
    }

    if (force) {
      terminalOwner.clearForExplicitStart();
      setTerminalSyncJob(null);
    }
    autoSyncStartedKey.current = key;
    syncSuppressedKey.current = null;
    setSyncAsins(values);
    setMessage(`已加入 ${values.length} 个竞品，后台正在全自动拉取数据（含 VOC）…`);
    return true;
  }, [syncAsins, catalogItems, setMessage, syncJobId, resumedSyncScope.canStart, terminalOwnerFor, terminalSyncJob?.status, workspaceReady, market, currentProjectId]);

  useEffect(() => {
    const parsed = parseAsinsParam(asinsParam);
    if (slugParam) return;
    if (!parsed) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setActiveAsins(current => (current.join(",") === parsed.join(",") ? current : parsed));
      replaceInputAsins(parsed);
    });
    return () => {
      cancelled = true;
    };
  }, [asinsParam, replaceInputAsins, slugParam]);

  const applyProject = (
    project: AnalysisProject,
    options?: { announce?: boolean; normalizeInput?: boolean; replace?: boolean },
  ) => {
    const changingWorkspace = project.id !== currentProjectId;
    const nextMarket = (project.marketplace in markets ? project.marketplace : "US") as MarketCode;
    setMarket(nextMarket);
    setActiveAsins(project.asins);
    if (options?.normalizeInput !== false) replaceInputAsins(project.asins);
    setCurrentProjectId(project.id);
    setCurrentProjectName(project.name);
    setReportProject({ id: project.id, kind: project.kind });
    if (projectSegmentName(project)) {
      setWorkspaceLabel(project.name);
    } else {
      setWorkspaceLabel("");
    }
    let params = new URLSearchParams(window.location.search);
    params.delete("asins");
    params.delete("project");
    if (changingWorkspace) {
      params.delete("run");
      params = clearVocRunFromSearch(params);
      params.delete("syncJob");
      restoringVocRun.current = null;
      setVocRun(null);
      setSelectedReportIds({});
      setSyncAsins(null);
      setSyncRunContext(null);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setStageOutputReceipt(null);
    }
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
    if (workspaceKey) {
      setHydratedWorkspaceKey(null);
      setSyncAsins(null);
      setSyncRunContext(null);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setStageOutputReceipt(null);
    }
    setRuntimeAnalysisData(null);
    runtimeAnalysisRequest.current += 1;
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
        replaceInputAsins(project.asins);
        setCurrentProjectId(project.id);
        setCurrentProjectName(project.name);
        setReportProject({ id: project.id, kind: project.kind });
        if (projectSegmentName(project)) {
          setWorkspaceLabel(project.name);
        } else {
          setWorkspaceLabel("");
        }
        if (workspaceKey) setHydratedWorkspaceKey(workspaceKey);
        void readHistoricalSyncPointer(project).then(pointer => {
          if (cancelled) return;
          const currentLocation = appLocationRef.current;
          const params = new URLSearchParams(currentLocation.search);
          params.delete("asins");
          params.delete("project");
          params.delete("run");
          params.delete("syncJob");
          if (pointer) {
            params.set("run", pointer.runId);
            params.set("syncJob", pointer.jobId);
            setSyncRunContext({ projectId: pointer.projectId, runId: pointer.runId });
          } else {
            setSyncRunContext(null);
          }
          const href = workspaceHref(project.slug, params);
          const current = `${currentLocation.pathname}${currentLocation.search ? `?${currentLocation.search}` : ""}`;
          if (current !== href) router.replace(href);
        });
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentProjectName(null);
          if (workspaceKey) setHydratedWorkspaceKey(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slugParam, projectParam, router, asinsParam, refreshRuntimeAnalysisData, replaceInputAsins, setMessage, workspaceKey]);

  useEffect(() => {
    if (!syncJobId || !workspaceReady || activeAsins.length === 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setMessage(`基础/MCP同步已启动，${activeAsins.length}个VOC待手工录入`);
    });
    return () => {
      cancelled = true;
    };
  }, [activeAsins.length, setMessage, syncJobId, workspaceReady]);

  const allNav: NavEntry[] = useMemo(
    () => [
      {
        id: "market-group",
        label: "市场调研",
        sub: "类目规模 · 销售 · 新品",
        children: marketNavigation.map(({ view, label, sub }) => ({ id: "market-overview", marketView: view, label, sub })),
      },
      {
        id: "overview-group",
        label: "竞品概览",
        sub: "参数 · 主辅图 · 变体",
        children: [
          { id: "overview", label: "竞品参数总览", sub: "参数 · 趋势 · 变体" },
          { id: "overview-images", label: "主辅图", sub: "主图 · 辅图 · 图册对比" },
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
  const nav:NavEntry[]=allNav.flatMap<NavEntry>(entry=>{
    if(!isNavGroup(entry))return canSeeTab(authSession.visibleModules,entry.id)?[entry]:[];
    const children=entry.children.filter(child=>canSeeTab(authSession.visibleModules,child.id));
    return children.length?[{...entry,children}]:[];
  });
  const activeFlyoutGroup = flyoutGroupId
    ? nav.find((entry): entry is NavGroup => isNavGroup(entry) && entry.id === flyoutGroupId) ?? null
    : null;
  const flyoutOpen = Boolean(activeFlyoutGroup);
  const activeLeaf = (() => {
    for (const entry of nav) {
      if (isNavGroup(entry)) {
        const child = entry.children.find(isLeafActive);
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

    if (currentProjectId) {
      try {
        const response = await localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(currentProjectId)}`);
        const existing = ((await response.json()) as { project?: AnalysisProject }).project;
        if (
          response.ok &&
          existing &&
          (existing.marketplace || "US") === market &&
          sameAsinSet(existing.asins, asins)
        ) return existing;
      } catch {
        // 精确复用失败后走 list/create；绝不修改旧项目。
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

  const prepareAnalysisFavorite = async () => {
    const name = workspaceLabel.trim();
    if (!name) {
      document.getElementById("workspace-segment-name")?.focus();
      throw new Error("请先填写细分名称，再收藏项目");
    }
    if (!currentProjectId) return false;
    if (name === currentProjectName) return true;
    const response = await localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(currentProjectId)}`, {
      method: "PATCH", body: JSON.stringify({ name }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(localAgentErrorMessage(payload, "保存细分名称失败，请重试"));
    setCurrentProjectName(name);
    setWorkspaces(previous => previous.map(project => project.id === currentProjectId ? { ...project, name } : project));
    return true;
  };

  const runAnalysis = async () => {
    let values: string[];
    if (activeTab === "overview") {
      if (!asinParse.canSubmit) return setMessage("请修正 ASIN 输入后再开始分析");
      values = [...asinParse.asins];
    } else {
      values = inputs.map(v => v.trim().toUpperCase()).filter(Boolean);
      if (values.length < 3) return setMessage("请至少输入 3 个竞品 ASIN");
      const invalid = values.find(v => !/^[A-Z0-9]{10}$/.test(v));
      if (invalid) return setMessage(`${invalid} 格式不正确，ASIN 应为 10 位字母或数字`);
      if (new Set(values).size !== values.length) return setMessage("请勿重复输入相同 ASIN");
    }
    if (analysisStartInFlight.current) return;
    analysisStartInFlight.current = true;
    try {
      const cleanParams = clearVocRunFromSearch(clearSyncJobFromSearch(window.location.search));
      cleanParams.delete("run");
      replaceAppUrl(cleanParams, window.location.pathname);
      restoringVocRun.current = null;
      setVocRun(null);
      setSelectedReportIds({});
      setSyncRunContext(null);
      const project = await ensureAnalysisWorkspace(values);
      if (!project?.id) throw new Error(PROJECT_REGISTRATION_FAILURE);
      let registrationResponse: Response;
      let registrationPayload: {
        project?: {
          id?: unknown;
          organizationId?: unknown;
          marketplace?: unknown;
          asins?: unknown;
        };
        error?: unknown;
      };
      try {
        registrationResponse = await localAgentFetch("/v1/projects", {
          method: "POST",
          headers: {
            "Idempotency-Key": `project-register:${project.id}`,
          },
          body: JSON.stringify({
            id: project.id,
            name: project.name,
            marketplace: market,
            asins: values,
          }),
        });
        registrationPayload = await registrationResponse.json() as typeof registrationPayload;
      } catch {
        throw new Error(PROJECT_REGISTRATION_FAILURE);
      }
      const registeredProject = registrationPayload.project;
      if (
        !registrationResponse.ok ||
        registeredProject?.id !== project.id ||
        registeredProject.organizationId !== authSession.user.organizationId ||
        registeredProject.marketplace !== market ||
        !Array.isArray(registeredProject.asins) ||
        !sameAsinSet(registeredProject.asins, values)
      ) {
        throw new Error(PROJECT_REGISTRATION_FAILURE);
      }
      const ownershipParams = new URLSearchParams(cleanParams);
      ownershipParams.delete("asins");
      ownershipParams.delete("project");
      replaceAppUrl(ownershipParams, projectWorkspacePath(project.slug));
      applyProject(
        { ...project, marketplace: market, asins: [...values] },
        { announce: false, normalizeInput: false, replace: true },
      );
      const response = await localAgentFetch("/v1/local-data/sync-asins", {
        method: "POST",
        body: JSON.stringify({
          asins: values,
          marketplace: market,
          projectId: registeredProject.id,
        }),
      });
      const payload = await response.json() as {
        jobId?: unknown;
        scope?: { projectId?: unknown; runId?: unknown };
        error?: unknown;
      };
      if (
        !response.ok ||
        typeof payload.jobId !== "string" ||
        !payload.jobId ||
        payload.scope?.projectId !== registeredProject.id ||
        typeof payload.scope.runId !== "string" ||
        !payload.scope.runId
      ) {
        throw new Error(localAgentErrorMessage(payload, "启动同步失败"));
      }

      replaceInputAsins(values);
      syncSuppressedKey.current = null;
      autoSyncStartedKey.current = values.join(",");
      const finalParams = new URLSearchParams(searchWithSyncJobId(cleanParams.toString(), payload.jobId));
      finalParams.set("run", payload.scope.runId);
      finalParams.delete("asins");
      finalParams.delete("project");
      if (!project?.slug) {
        finalParams.set("asins", values.join(","));
      }
      const finalHref = workspaceHref(project?.slug, finalParams);
      replaceAppUrl(finalParams, projectWorkspacePath(project?.slug));
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setSyncAsins(null);
      router.replace(finalHref);
      setSyncRunContext({
        projectId: registeredProject.id,
        runId: payload.scope.runId,
      });
      setMessage(`基础/MCP同步已启动，${values.length}个VOC待手工录入`);
      return;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动同步失败");
    } finally {
      analysisStartInFlight.current = false;
    }
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

  const selectSavedReportVersion = async (
    stage: keyof typeof savedReportStageLabels,
    reportId: string,
  ) => {
    const runId = vocRun?.runId;
    if (!runId) return;
    try {
      const report = await readSavedAnalysisReport(reportId);
      if (report.runId !== runId || report.stage !== stage) {
        throw new Error("Saved report does not belong to this run and stage");
      }
      setVocRun((current) => current
        ? {
            ...current,
            reports: current.reports.map((candidate) => candidate.id === report.id ? report : candidate),
            report: stage === "voc-positioning" ? report : current.report,
          }
        : current);
      setSelectedReportIds((current) => ({ ...current, [stage]: report.id }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取已保存报告失败");
    }
  };

  const downloadSavedAnalysisReports = () => {
    if (!savedReportView) {
      setMessage("当前运行没有可导出的已保存报告");
      return;
    }
    const url = URL.createObjectURL(new Blob(
      [serializeSavedAnalysisReportView(savedReportView)],
      { type: "application/json" },
    ));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `analysis-run-${savedReportView.runId}-reports.json`;
    anchor.click();
    URL.revokeObjectURL(url);
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
      const response = await localAgentFetch("/v1/local-data/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "keyword-compare",
          sourceProjectId: await sourceProjectIdForSave(currentProjectId),
          name: `${categoryHint} · 流量词对比 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: activeAsins,
          note: `来自竞品关键词分析 · ${activeAsins.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "保存失败"));
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
      const response = await localAgentFetch("/v1/local-data/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "traffic-promo",
          sourceProjectId: await sourceProjectIdForSave(currentProjectId),
          name: `${categoryHint} · 推广能力分析 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: values,
          note: `来自竞品流量分析 · ${values.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "保存失败"));
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
      const response = await localAgentFetch("/v1/local-data/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "checklist",
          sourceProjectId: await sourceProjectIdForSave(currentProjectId),
          name: `${categoryHint} · 立项确认清单 · ${stamp}`,
          majorCategory: inferAmazonMajorCategory(products),
          categoryLabel: categoryHint,
          marketplace: market,
          asins: activeAsins,
          note: `来自立项前确认清单 · ${activeAsins.length} 个 ASIN`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "保存失败"));
      const project = payload.project as AnalysisProject;
      applyProject(project, { announce: false });
      setMessage(`已保存到收藏夹「项目确认清单」：${project.name}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存到项目确认清单失败");
    } finally {
      setSavingChecklist(false);
    }
  };

  return <main className={`app-shell${flyoutOpen ? " flyout-open" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    {publicationConvergenceNotice ? <div role="status">{publicationConvergenceNotice}</div> : null}
    <div className="nav-rail">
    <aside className="sidebar" aria-label="主导航侧栏">
      <SidebarCollapseToggle collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
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
      <nav id="primary-navigation" aria-label="功能模块">
        {nav.map(entry => (
          <Fragment key={entry.id}>
            {isNavGroup(entry) ? (
              <button
                type="button"
                data-dim={entry.id}
                aria-label={entry.label}
                title={sidebarCollapsed ? entry.label : undefined}
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
<ModuleVisibilityLink
                visibleModules={authSession.visibleModules} tab={entry.id} href={tabHref(entry.id)}
                data-dim={entry.id}
                aria-label={entry.label}
                aria-current={activeTab === entry.id ? "page" : undefined}
                title={sidebarCollapsed ? entry.label : undefined}
                className={activeTab === entry.id ? "nav-item active" : "nav-item"}
                onClick={closeFlyout}
              >
                <NavThemeIcon dim={entry.id} />
                <span className="nav-item-copy">
                  <b>{entry.label}</b>
                  <NavSubText text={entry.sub} />
                </span>
              </ModuleVisibilityLink>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <HelpFeedbackDrawer user={authSession.user} />
        {activeTab === "market-overview" ? <div className="sync-status">采集状态请查看任务记录</div> : <div className="sync-status">{reportReadStatus || catalogStatusLabel || <><i/>数据源状态正常</>}</div>}
        {activeTab === "market-overview" ? <p>{activeMarketSite} · 类目调研</p> : <p>{markets[market].label} · 当前对比<br/><b>{products.length} 个 ASIN</b></p>}
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
<ModuleVisibilityLink
              key={child.marketView ?? child.id}
              visibleModules={authSession.visibleModules} tab={child.id} href={leafHref(child)}
              data-dim={child.marketView ? marketNavigation.find(item => item.view === child.marketView)!.visualDim : child.id}
              className={isLeafActive(child) ? "sidebar-flyout-item active" : "sidebar-flyout-item"}
              aria-current={isLeafActive(child) ? "page" : undefined}
              onClick={closeFlyout}
            >
              <NavThemeIcon dim={child.marketView ? marketNavigation.find(item => item.view === child.marketView)!.visualDim : child.id} />
              <span className="nav-item-copy">
                <b>{child.label}</b>
                <NavSubText text={child.sub} />
              </span>
            </ModuleVisibilityLink>
          ))}
        </div>
      ) : null}
    </aside>
    </div>

    <section className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">{activeTab === "market-overview" ? `市场调研 · Amazon ${activeMarketSite}` : `${products[0]?.subRankCategory && products[0].subRankCategory !== "等待同步" ? products[0].subRankCategory : "竞品分析"} · Amazon ${markets[market].short}`}</p>
          <h1>{pageTitle}</h1>
        </div>
        <div className="top-actions">
          <AuthIdentityControl session={authSession} />
          {activeTab === "market-overview" ? null : activeTab === "keywords" ? (
            <>
{canSeeTab(authSession.visibleModules,'keyword-compare')&&<button
                type="button"
                className="ghost-btn"
                disabled={savingKeywordCompare || activeAsins.length < 3}
                onClick={() => void saveKeywordCompareProject()}
              >
                {savingKeywordCompare ? "保存中…" : "保存到流量词对比"}
              </button>}
              <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
                抓取关键词数据
              </button>
            </>
          ) : activeTab === "traffic" ? (
            <>
{canSeeTab(authSession.visibleModules,'traffic-promo')&&<button
                type="button"
                className="ghost-btn"
                disabled={savingTrafficPromo || inputs.filter(Boolean).length < 3}
                onClick={() => void saveTrafficPromoProject()}
              >
                {savingTrafficPromo ? "保存中…" : "保存到推广能力分析"}
              </button>}
              <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
                抓取流量数据
              </button>
            </>
          ) : activeTab === "checklist" ? (
            <>
{canSeeTab(authSession.visibleModules,'checklist-library')&&<button
                type="button"
                className="ghost-btn"
                disabled={savingChecklist || activeAsins.length < 3}
                onClick={() => void saveChecklistProject()}
              >
                {savingChecklist ? "保存中…" : "保存到项目确认清单"}
              </button>}
<ModuleVisibilityLink className="primary-btn" visibleModules={authSession.visibleModules} tab={"overview"} href={tabHref("overview")}>管理竞品 ASIN</ModuleVisibilityLink>
            </>
          ) : (
            <>

<ModuleVisibilityLink className="primary-btn" visibleModules={authSession.visibleModules} tab={"overview"} href={tabHref("overview")}>管理竞品 ASIN</ModuleVisibilityLink>
            </>
          )}
        </div>
      </header>
      <ConcurrencyAdminPanel user={authSession.user} />
      {activeTab !== "market-overview" && <div className="comparison-context"><span>目标市场 <b>{markets[market].label} {markets[market].short}</b></span><span>竞品数量 <b>{products.length} / 10</b></span><span>对比模式 <b>多 ASIN 同屏</b></span><SourceBadge>{reportReadStatus || catalogSourceLabel}</SourceBadge></div>}

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

      {displayVersionPending ? <p className="stage-output-gap-notice" role="status">正在读取项目当前报告…</p> : null}
      {displayVersionReadFailed ? <p className="stage-output-gap-notice" role="alert">当前报告读取失败，请刷新后重试；页面不会显示未核实的历史数据。</p> : null}
      {displayVersionMissing ? <p className="stage-output-gap-notice" role="status">{showUnpublishedProgress
        ? "分析进行中，以下为本次任务已返回的结果；完整报告将在分析结束后显示。"
        : "当前项目暂无可读取的分析报告。首次分析可正常启动；若此前已完成分析，请联系管理员恢复报告。"}</p> : null}


      {activeTab === "market-overview" && !authSession.logoutPending && <div className="page-content"><MarketResearchSection sessionIdentity={runtimeSessionKey} showAuditDetails={authSession.user.role === "admin"} view={activeMarketView} onViewChange={view => router.push(marketViewHref(view, window.location.search), { scroll: false })} /></div>}

      {activeTab === "overview" && <div className="page-content compare-page">
        <section className="card asin-builder">
          <div className="section-head"><div><h3>设置对标竞品</h3><p>工作区按「类目 + 站点」分开：美国落地灯是 /p/floor-lamps-us，英国站会是 /p/floor-lamps-uk。同一站点再开一批细分（如儿童三轮 vs 成人滑板车）会再生成新地址。输入 3–10 个 ASIN 后点「开始全自动分析」。</p></div><span className="required-note">3–10 个</span></div>
          <div className="asin-builder-body">
            <div className="builder-meta-row">
            <label className="market-inline"><strong>目标市场</strong><select value={market} onChange={e=>{const next=e.target.value as MarketCode;setMarket(next);setMessage(`已切换至 ${markets[next].label}，ASIN 链接与数据口径将同步更新`);}}>{Object.entries(markets).map(([code,item])=><option key={code} value={code}>{item.option}</option>)}</select></label>
            <label className="workspace-alias-field">
              <strong>细分名称</strong>
              <input
                id="workspace-segment-name"
                value={workspaceLabel}
                onChange={e => setWorkspaceLabel(e.target.value)}
                placeholder="收藏前必填，如：融蜡灯 / 儿童三轮"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            </div>
            <BatchAsinInput raw={asinDraft} result={asinParse} onRawChange={setAsinDraft} />
            {workspaces.length > 0 ? (
              <WorkspaceHistoryStrip
                workspaces={workspaces}
                currentProjectId={currentProjectId}
                buildHref={workspace => projectWorkspacePath(workspace.slug)}
              />
            ) : null}
            {mixedFamilies ? (
              <p className="mixed-family-note">
                当前表里混了不同品类。请分别打开对应工作区，不要把滑板车和落地灯放在同一页对比。
              </p>
            ) : null}
          </div>
          <div className="builder-actions">
            {canSeeTab(authSession.visibleModules,'projects')&&<AnalysisProjectFavoriteButton projectId={currentProjectId} favorites={projectFavorites} beforeFavorite={prepareAnalysisFavorite} />}
<ModuleVisibilityLink className="ghost-btn" visibleModules={authSession.visibleModules} tab={"projects"} href={tabHref("projects")}>收藏与历史</ModuleVisibilityLink>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            {showBuilderNotice ? (
              <span
                className={
                  message.includes("请") || message.includes("不正确") || message.includes("重复")
                    ? "builder-message error"
                    : "builder-message"
                }
              >
                {message}
              </span>
            ) : null}
            <button className="primary-btn" onClick={runAnalysis}>开始全自动分析</button>
          </div>
        </section>

        {activeAsins.length > 0 || syncAsins ? (
        <AsinSyncProgressSection visibleModules={authSession.visibleModules}
          asins={activeAsins}
          marketplace={market}
          syncRequest={syncAsins}
          syncResume={syncResume}
          onRequestSync={() => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          }}
          onSyncComplete={async () => {
            await refreshRuntimeAfterSync("MCP 同步完成，最新分析数据已刷新");
          }}
          onSyncDismiss={() => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
            setSyncRunContext(null);
            replaceAppUrl(clearSyncJobFromSearch(window.location.search), window.location.pathname);
          }}
        />
        ) : null}

        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="category" />
        <CompetitorOverviewCategoryTrend products={products} market={market} categoryTrendByNode={categoryTrendByNode} />

        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="sales_trend" />
        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="price_strategy" />
        <CompetitorOverviewMatrix products={products} market={market} slugParam={slugParam} salesTrendByAsin={salesTrendByAsin} ratingByAsin={ratingByAsin} fbaFeeByAsin={fbaFeeByAsin} childSalesByAsin={childSalesByAsin} priceStrategyByAsin={priceStrategyByAsin} listingContentByAsin={listingContentByAsin} presentation="page" translationProjectId={authSession.logoutPending ? null : currentProjectId} translationVersionId={authSession.logoutPending ? null : currentDisplayVersion?.versionId ?? null} translationKey={`${runtimeSessionKey}:${currentProjectId}`} />

        <CompetitorOverviewHistory products={products} market={market} salesTrendByAsin={salesTrendByAsin} metric={salesView} onMetricChange={setSalesView} />

        <XydcVariantSection
          products={products.map(product => ({
            asin: product.asin,
            brand: product.brand,
            title: product.title,
            image: product.image,
          }))}
          families={runtimeAnalysisData?.variants.families ?? []}
          orderFamilies={runtimeAnalysisData?.variantOrders.families ?? []}
          progress={runtimeAnalysisDataScope === runtimeScopeKey ? runtimeAnalysisData?.xydcOrderProgress ?? null : null}
          market={markets[market]}
        />
      </div>}

      {activeTab === "overview-images" && (
        <div className="page-content compare-page">
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
          <ListingImageSourceProject key={`${runtimeScopeKey}:${currentProjectId}`} projectId={currentProjectId} asins={activeAsins} marketplace={market} onContext={setImageProjectContext} onOpen={project=>applyProject(project)} />
          <ListingImagesSection
            key={runtimeScopeKey}
            imageActionJob={currentImageJob}
            onImageAction={resumedProjectId && imageProjectContext?.projectId === currentProjectId && imageProjectContext.kind === "analysis" ? runListingImageAction : undefined}
            imageActionPending={terminalRepairPending || Boolean(syncAsins)}
            products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
            market={markets[market]}
            colors={colors}
            listingByAsin={listingContentByAsin}
            reportUnavailableReason={displayVersionPending ? "正在读取图册所属报告"
              : displayVersionReadFailed ? "图册所属报告读取失败"
              : displayVersionMissing && !showUnpublishedProgress ? "暂无已发布图册，待分析完成或恢复报告" : undefined}
            resolveImageRemark={(asin, slotIndex) => {
              const slots = imageRemarksByAsin[asin];
              return Array.isArray(slots) ? slots[slotIndex] as never ?? null : null;
            }}
            resolveImageOverlay={(asin, slotIndex) => currentDisplayVersion?.imageRemarkOverlay?.find(
              entry => entry.asin === asin && entry.index === slotIndex) ?? null}
            resolveImageOutcome={(asin, slotIndex) => {
              const slots = imageRemarkOutcomesByAsin[asin];
              const candidate = Array.isArray(slots) ? slots[slotIndex] : null;
              return candidate && typeof candidate === "object" && !Array.isArray(candidate)
                ? candidate as never
                : null;
            }}
          />
        </div>
      )}

      {activeTab === "voc" && <div className="page-content compare-page">
        <VocOverviewIntroduction products={products} />
        <AlexaVocImportPanel
          marketplace={market}
          key={`${authSession.sessionIdentity}:${authSession.user.organizationId}:${market}`}
          projectId={alexaVocPageScope.authoritativeImportScope?.projectId ?? null}
          runId={alexaVocPageScope.authoritativeImportScope?.runId ?? null}
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title }))}
          effectiveVocByAsin={manualVoc.effectiveVocByAsin}
          statusByAsin={manualVoc.statusByAsin}
          onImported={manualVoc.onImported}
          pollingEnabled={alexaVocPageScope.canPoll}
          disabled={!alexaVocPageScope.authoritativeImportScope}
        />
        <ManualVocMatrixSection products={products} market={market}
          effectiveVocByAsin={manualVoc.effectiveVocByAsin} statusByAsin={manualVoc.statusByAsin}
          onRetry={() => void manualVoc.refresh()} />
        {reviewGapReasonCode ? (
          <StageOutputGapNotice
            label="评论数据"
            asins={activeAsins}
            records={reviewAnalysisByAsin}
            reasonCode={reviewGapReasonCode}
            gapItems={stageOutputSnapshot.reviews && "gap" in stageOutputSnapshot.reviews ? stageOutputSnapshot.reviews.gap.items : []}
          />
        ) : null}
        {reviewRefreshFailed ? <p role="status">本次评论结果读取失败；如有本项目已验证结果，将继续保留显示。重新进入 VOC 页可重试读取。</p> : null}
        <ReviewContextSection asins={activeAsins} records={reviewAnalysisByAsin} contexts={reviewContexts}
          missingMessages={Object.fromEntries(activeAsins.map(asin => [asin, reviewMissingMessage(stageOutputSnapshot.reviews, asin)]))} />
        <ReviewAnalysisMatrixSection
          title="智能评论分析"
          description="按各 ASIN 实际来源的评论样本与 Customers Say 主题展示 · 六维同屏对齐 · 格式：【分类】+ 提及占比；来源、样本数和采集时间见表头。"
          badge={Object.values(reviewAnalysisByAsin).some(record => record.sourceProvider === "sellerSprite") ? "Sorftime / 卖家精灵 MCP" : "Sorftime MCP"}
          data={reviewAnalysisByAsin}
          missingMessages={Object.fromEntries(activeAsins.map(asin => [asin, reviewMissingMessage(stageOutputSnapshot.reviews, asin)]))}
          dataMeta={{ ...sorftimeReviewDataMeta, updatedAt: stageOutputSnapshot.reviews && "updatedAt" in stageOutputSnapshot.reviews ? stageOutputSnapshot.reviews.updatedAt : "当前项目结果尚未读取" }}
          configMeta={sorftimeReviewAnalysisMeta}
          pendingSteps={
            <>
              服务端 Sorftime 连接器尚未配置或数据尚未同步。请联系管理员配置连接器后运行{" "}
              <code>{sorftimeReviewAnalysisMeta.syncCommand}</code>。
            </>
          }
          products={products}
          market={market}
        />
        <VocSevenDimensionInsightSection products={products} manualVocByAsin={manualVocByAsin} reviewAnalysisData={reviewAnalysisByAsin} />
        {(vocRun || savedReportView) ? <section className="card launch-block" data-voc-run={vocRun?.runId ?? undefined}>
            <VocRunStatusSummary observation={vocRun} />
            {vocRun?.kind === "active" ? (
              <button type="button" className="ghost-btn" onClick={() => void cancelCurrentVocRun()}>取消运行</button>
            ) : null}
            {vocRun?.kind === "failed" ? (
              <button type="button" className="ghost-btn" onClick={() => void retryCurrentVocStage()}>重试 VOC 阶段</button>
            ) : null}
            {vocRun?.kind === "waiting-input" ? <p>需要补齐可信 VOC 数据后再重试；不会自动采集外部数据。</p> : null}
            {savedReportView ? (
              <div data-saved-analysis-reports={savedReportView.runId}>
                {savedReportView.stages.map((slot) => (
                  <article key={slot.stage} data-report-stage={slot.stage}>
                    <strong>{savedReportStageLabels[slot.stage]} · {slot.stage}</strong>
                    {slot.history.length ? (
                      <label>
                        已保存报告版本
                        <select
                          value={slot.selected?.id ?? ""}
                          onChange={(event) => void selectSavedReportVersion(slot.stage, event.target.value)}
                        >
                          {slot.history.map((report) => (
                            <option key={report.id} value={report.id}>
                              v{report.version} · {report.status}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p>暂无已保存报告</p>
                    )}
                    {slot.selected ? (
                      <>
                        <p>
                          Report {slot.selected.id} · v{slot.selected.version} · {slot.selected.status}
                        </p>
                        <p>
                          Skill {slot.selected.skill.id}@{slot.selected.skill.version}
                        </p>
                        <details>
                          <summary>查看已保存结果</summary>
                          <pre>{JSON.stringify(slot.selected.result, null, 2)}</pre>
                        </details>
                      </>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}
          </section> : null}
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
<ModuleVisibilityLink className="ghost-btn" visibleModules={authSession.visibleModules} tab={"keyword-compare"} href={tabHref("keyword-compare")}>
              ★ 流量词对比
            </ModuleVisibilityLink>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            {showBuilderNotice ? (
              <span
                className={
                  message.includes("请") || message.includes("不正确") || message.includes("重复") || message.includes("失败")
                    ? "builder-message error"
                    : "builder-message"
                }
              >
                {message}
              </span>
            ) : null}
{canSeeTab(authSession.visibleModules,'keyword-compare')&&<button type="button" className="ghost-btn" disabled={savingKeywordCompare || activeAsins.length < 3} onClick={() => void saveKeywordCompareProject()}>
              {savingKeywordCompare ? "保存中…" : "保存到流量词对比"}
            </button>}
            <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
              抓取关键词数据
            </button>
          </div>
        </section>

        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="keywords" />
        <KeywordFetchStatusSection
          products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
          marketplace={market}
          syncRequest={syncAsins}
          syncResume={syncResume}
          keywordAnalysisByAsin={keywordAnalysisByAsin}
          keywordEnrichmentByKeyword={keywordEnrichmentByKeyword}
          onRequestSync={() => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          }}
          onSyncComplete={async () => {
            await refreshRuntimeAfterSync("关键词相关数据已就绪，可继续分析或保存到流量词对比");
          }}
          onSyncDismiss={() => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
          }}
        />

        <KeywordDemandSection
          analysisScope={productLaunchSources.analysisScope}
          mode="analysis"
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title, subRankCategory: p.subRankCategory, image: p.image, price: p.price }))}
          sources={{ analysisByAsin: keywordAnalysisByAsin, enrichmentByKeyword: keywordEnrichmentByKeyword }}
        />
      </div>}

      {activeTab === "keyword-insight" && <div className="page-content compare-page">
        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="keywords" />
        <KeywordDemandSection
          analysisScope={productLaunchSources.analysisScope}
          mode="insight"
          products={products.map(p => ({ asin: p.asin, brand: p.brand, title: p.title, subRankCategory: p.subRankCategory, image: p.image, price: p.price }))}
          sources={{ analysisByAsin: keywordAnalysisByAsin, enrichmentByKeyword: keywordEnrichmentByKeyword }}
        />
      </div>}

      {activeTab === "launch" && <div className="page-content compare-page">
        <ProductLaunchRecommendationSection products={products} sources={productLaunchSources} />
      </div>}

      {activeTab === "voc-positioning" && <div className="page-content compare-page">
        <VocPositioningSection products={products} sources={productLaunchSources} />
      </div>}

      {activeTab === "definition" && <div className="page-content compare-page">
        {market !== "US" ? <VocEvidenceDefinition
          key={`${runtimeSessionKey}:${currentProjectId}:${baseSyncRunId}:${market}`}
          projectId={currentProjectId} baseSyncRunId={baseSyncRunId}
          sessionKey={runtimeSessionKey} organizationId={authSession.user.organizationId}
          marketplace={market} asins={activeAsins} products={products} sources={productLaunchSources}
          initialRunId={new URLSearchParams(appSearch).get("vocRun")}
          initialHistoryRunId={new URLSearchParams(appSearch).get("vocHistory")}
          initialSelectedAsins={new URLSearchParams(appSearch).get("vocAsins")?.split(",")}
          refreshToken={[stageOutputSnapshot.reviews, stageOutputSnapshot.keywords].map(output => output && "outputVersion" in output ? output.outputVersion : "").join(":")}
          enabled={!authSession.logoutPending && workspaceReady}
          onRunStarted={(id, asins, previousRunId) => {
            const url = new URL(window.location.href);
            url.searchParams.set("vocRun", id);
            url.searchParams.set("vocAsins", asins.join(","));
            if (previousRunId) url.searchParams.set("vocHistory", previousRunId);
            router.replace(`${url.pathname}${url.search}`, { scroll: false });
          }}
        /> : <LocalVocDefinition
          key={`${runtimeSessionKey}:${currentProjectId}:${baseSyncRunId}:${market}:${activeAsins.join(",")}`}
          initialRunId={new URLSearchParams(appSearch).get("vocRun")}
          initialHistoryRunId={new URLSearchParams(appSearch).get("vocHistory")}
          organizationId={authSession.user.organizationId} sessionKey={runtimeSessionKey}
          refreshToken={`${[stageOutputSnapshot.reviews, stageOutputSnapshot.keywords].map(output => output && "outputVersion" in output ? output.outputVersion : "").join(":")}:${manualVocSourceVersion}`}
          projectId={currentProjectId} baseSyncRunId={baseSyncRunId} jobId={stageOutputJobId} onImported={manualVoc.onImported}
          products={products} sources={productLaunchSources}
          initialSelectedAsins={new URLSearchParams(appSearch).get("vocAsins")?.split(",")}
          enabled={!authSession.logoutPending && workspaceReady && market === "US"}
        />}
      </div>}

      {activeTab === "checklist" && <div className="page-content compare-page">
        <LaunchChecklistSection
          sources={productLaunchSources}
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
          onSaveToLibrary={canSeeTab(authSession.visibleModules,'checklist-library')?() => void saveChecklistProject():undefined}
          savingToLibrary={savingChecklist}
          canSaveToLibrary={activeAsins.length >= 3}
          libraryHref={canSeeTab(authSession.visibleModules,'checklist-library')?tabHref("checklist-library"):undefined}
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
<ModuleVisibilityLink className="ghost-btn" visibleModules={authSession.visibleModules} tab={"traffic-promo"} href={tabHref("traffic-promo")}>
              ★ 推广能力分析
            </ModuleVisibilityLink>
            {currentProjectName ? (
              <span className="builder-project-chip">
                当前工作区：{currentProjectName}
                {slugParam ? ` · /p/${slugParam}` : ""}
              </span>
            ) : null}
            {showBuilderNotice ? (
              <span
                className={
                  message.includes("请") || message.includes("不正确") || message.includes("重复") || message.includes("失败")
                    ? "builder-message error"
                    : "builder-message"
                }
              >
                {message}
              </span>
            ) : null}
{canSeeTab(authSession.visibleModules,'traffic-promo')&&<button type="button" className="ghost-btn" disabled={savingTrafficPromo || inputs.filter(Boolean).length < 3} onClick={() => void saveTrafficPromoProject()}>
              {savingTrafficPromo ? "保存中…" : "保存到推广能力分析"}
            </button>}
            <button type="button" className="primary-btn" onClick={() => void runAnalysis()}>
              抓取流量数据
            </button>
          </div>
        </section>

        <StageOutputGapCard snapshot={stageOutputSnapshot} stage="traffic" />
        {authSession.user.role === 'admin' && !authSession.logoutPending && baseSyncRunId && trafficSnapshotState.kind === 'dynamic' && <TrafficDetailRecoveryControl key={trafficBindingKey} runId={baseSyncRunId} recovered={Boolean(trafficData?.authoritativeListingAsins?.length)} onRecovered={async () => trafficSnapshotOwner.current?.refresh()} />}
        <TrafficFetchStatusSection
          products={products.map(p => ({ asin: p.asin, brand: p.brand, image: p.image }))}
          marketplace={market}
          trafficData={stageOutputView.trafficData}
          trafficOrigin={stageOutputSnapshot.traffic?.stageStatus === "done" ? "dynamic" : trafficOrigin}
          syncRequest={syncAsins}
          syncResume={syncResume}
          onRequestSync={() => {
            if (activeAsins.length < 3) {
              setMessage("请至少输入 3 个竞品 ASIN");
              return;
            }
            syncSuppressedKey.current = null;
            autoSyncStartedKey.current = null;
            void startSyncIfNeeded(activeAsins, { force: true });
          }}
          onSyncComplete={async () => {
            await refreshRuntimeAfterSync("流量相关数据已就绪，可继续分析或保存到推广能力分析");
          }}
          onSyncDismiss={() => {
            syncSuppressedKey.current = activeAsins.join(",");
            setSyncAsins(null);
          }}
        />

        <TrafficReportView products={products} market={market} trafficData={stageOutputView.trafficData} />
      </div>}

      {activeTab === "keyword-compare" && <div className="page-content compare-page">
        {syncAsins || syncResume.syncJobId || syncResume.terminalJob ? (
          <UrlResumableAsinSyncFunnel visibleModules={authSession.visibleModules}
            asins={activeAsins}
            marketplace={market}
            syncRequest={syncAsins}
            resume={syncResume}
            focusStageIds={["catalog", "keywords"]}
            onComplete={async () => {
              await refreshRuntimeAfterSync("关键词相关数据已刷新");
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
        {syncAsins || syncResume.syncJobId || syncResume.terminalJob ? (
          <UrlResumableAsinSyncFunnel visibleModules={authSession.visibleModules}
            asins={activeAsins}
            marketplace={market}
            syncRequest={syncAsins}
            resume={syncResume}
            focusStageIds={["catalog", "traffic"]}
            onComplete={async () => {
              await refreshRuntimeAfterSync("流量相关数据已刷新");
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
        {syncAsins || syncResume.syncJobId || syncResume.terminalJob ? (
          <UrlResumableAsinSyncFunnel visibleModules={authSession.visibleModules}
            asins={activeAsins}
            marketplace={market}
            syncRequest={syncAsins}
            resume={syncResume}
            focusStageIds={["catalog", "reviews", "alexa_voc"]}
            onComplete={async () => {
              await refreshRuntimeAfterSync("竞品与 VOC 相关数据已刷新");
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
          key={runtimeSessionKey}
          favorites={projectFavorites}
          exportVisibleModules={authSession.visibleModules}
          exportIdentity={authSession.logoutPending ? undefined : {sessionIdentity: authSession.sessionIdentity, organizationId: authSession.user.organizationId}}
          canDeleteProjects={authSession.user.role === "admin" && !authSession.logoutPending}
          onProjectDeleted={id => {
            setWorkspaces(previous => previous.filter(project => project.id !== id));
            if (id !== currentProjectId) return;
            setCurrentProjectId(null);
            setCurrentProjectName(null);
            setWorkspaceLabel("");
            setActiveAsins([]);
            replaceInputAsins([]);
            syncSuppressedKey.current = activeAsins.join(",");
            autoSyncStartedKey.current = null;
            restoringVocRun.current = null;
            setVocRun(null);
            setSelectedReportIds({});
            setSyncAsins(null);
            setSyncRunContext(null);
            setTerminalSyncJob(null);
            setTerminalPointerRetained(false);
            setStageOutputReceipt(null);
            setRuntimeAnalysisData(null);
            runtimeAnalysisRequest.current += 1;
            // Leave the deleted workspace entirely so in-flight run observers cannot
            // restore its pointers or recreate its project from the old ASIN input.
            window.location.replace("/?tab=projects&projectDeleted=1");
          }}
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
    <div className="floating-action-stack">
      <BackToTopButton />
    </div>
  </main>;
}

export default function Home() {
  return (
    <AuthSessionGate>
      {(authSession) => <AuthenticatedAmazonOpportunityApp authSession={authSession} />}
    </AuthSessionGate>
  );
}
