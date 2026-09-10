"use client";

import { useMemo } from "react";
import { sifListingTrafficMeta } from "../../sif-listing-traffic-data";
import { buildStageOutputView } from "../../lib/stage-output-view";
import { sifKeywordAnalysisData } from "../../sif-keyword-analysis-data";
import { sifKeywordEnrichmentData } from "../../sif-keyword-enrichment-data";
import { sorftimeReviewAnalysisData } from "../../sorftime-review-analysis-data";
import { sorftimeRatingData } from "../../sorftime-rating-data";
import { sorftimeSalesTrendData } from "../../sorftime-sales-trend-data";
import { sorftimeFbaFeeData } from "../../sorftime-fba-fee-data";
import { sorftimeListingContentData } from "../../sorftime-listing-content-data";
import { sorftimeCategoryTrendData } from "../../sorftime-category-trend-data";
import { sorftimeChildSales30d } from "../../sorftime-child-sales-data";
import { sorftimePriceStrategies } from "../../sorftime-price-strategy-data";
import { listingImageRemarks } from "../../listing-image-remarks";
import { scopedReviewRecords } from "../../lib/voc-review-display";
import { stageOutputGapReasonCode } from "../sync/stage-output-gap-notice";
import { type ProductLaunchRuntimeSources } from "../product-reports/product-launch-analysis";
import { buildKeywordDemandAnalysis } from "../keywords/keyword-demand-analysis";
import { type Product } from "../catalog/product-contracts";
import type { useStageOutput } from "./stage-output";
import type { useRuntimeDataState } from "./workspace-runtime";
import type { useTrafficSnapshot } from "./traffic-snapshot";
import type { useWorkspaceInput } from "./workspace-input";
import type { useWorkspaceVocSources } from "./workspace-voc-sources";

type useWorkspaceSourceModelInputs = Pick<ReturnType<typeof useStageOutput>, "stageOutputSnapshot" | "visibleTrafficStage">
  & Pick<ReturnType<typeof useRuntimeDataState>, "runtimeAnalysisData">
  & Pick<ReturnType<typeof useTrafficSnapshot>, "trafficData">
  & Pick<ReturnType<typeof useWorkspaceInput>, "activeAsins" | "market">
  & Pick<ReturnType<typeof useWorkspaceVocSources>, "manualVocByAsin" | "products">;

export function useWorkspaceSourceModel({
    stageOutputSnapshot, visibleTrafficStage, runtimeAnalysisData, trafficData, activeAsins, market, manualVocByAsin,
    products,
  }: useWorkspaceSourceModelInputs) {
  const stageOutputView = useMemo(
    () => buildStageOutputView({ ...stageOutputSnapshot, traffic: visibleTrafficStage.traffic }, {
      keywordAnalysisByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.keywords.analysisByAsin as typeof sifKeywordAnalysisData
        : sifKeywordAnalysisData,
      keywordEnrichmentByKeyword: runtimeAnalysisData
        ? runtimeAnalysisData.keywords.enrichmentByKeyword as typeof sifKeywordEnrichmentData
        : sifKeywordEnrichmentData,
      // Global generated review files carry no project/run/job ownership.
      reviewAnalysisByAsin: {} as typeof sorftimeReviewAnalysisData,
      ratingByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.reviews.ratingByAsin as typeof sorftimeRatingData
        : sorftimeRatingData,
      salesTrendByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.salesTrend.trendByAsin as typeof sorftimeSalesTrendData
        : sorftimeSalesTrendData,
      fbaFeeByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.fba.feeByAsin as typeof sorftimeFbaFeeData
        : sorftimeFbaFeeData,
      listingContentByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.listing.contentByAsin as typeof sorftimeListingContentData
        : sorftimeListingContentData,
      categoryTrendByNode: runtimeAnalysisData
        ? runtimeAnalysisData.category.trendByNode as typeof sorftimeCategoryTrendData
        : sorftimeCategoryTrendData,
      childSalesByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.childSales.rowsByAsin as typeof sorftimeChildSales30d
        : sorftimeChildSales30d,
      priceStrategyByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.priceStrategy.strategyByAsin as typeof sorftimePriceStrategies
        : sorftimePriceStrategies,
      imageRemarksByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.imageRemarks.remarksByAsin as typeof listingImageRemarks
        : listingImageRemarks,
      imageRemarkOutcomesByAsin: runtimeAnalysisData
        ? runtimeAnalysisData.imageRemarks.outcomesByAsin
        : {},
      trafficData: trafficData ?? {
        overview: {},
        monthlyTrend: {},
        meta: sifListingTrafficMeta,
      },
    }),
    [runtimeAnalysisData, stageOutputSnapshot, visibleTrafficStage.traffic, trafficData],
  );

  const {
    keywordAnalysisByAsin, keywordEnrichmentByKeyword, ratingByAsin,
    salesTrendByAsin, fbaFeeByAsin, listingContentByAsin, categoryTrendByNode,
    childSalesByAsin, priceStrategyByAsin, imageRemarksByAsin, imageRemarkOutcomesByAsin,
  } = stageOutputView;

  const reviewAnalysisByAsin = useMemo(() => scopedReviewRecords(stageOutputView.reviewAnalysisByAsin, activeAsins, market), [stageOutputView.reviewAnalysisByAsin, activeAsins, market]);

  const reviewGapReasonCode = stageOutputGapReasonCode(stageOutputSnapshot.reviews);

  const fbaGapReasonCode = stageOutputGapReasonCode(stageOutputSnapshot.fba);

  const productLaunchSources = useMemo<ProductLaunchRuntimeSources>(() => ({
    manualVocByAsin,
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
  }), [keywordAnalysisByAsin, keywordEnrichmentByKeyword, manualVocByAsin, products]);

  const trafficOverviewByAsin = stageOutputView.trafficData.overview;

  const trafficMonthlyTrendByAsin = stageOutputView.trafficData.monthlyTrend;

  const trafficMeta = stageOutputView.trafficData.meta;

  const mixedFamilies = useMemo(() => {
    const families = new Set(
      products.map(item => item.productFamily).filter((item): item is NonNullable<Product["productFamily"]> => Boolean(item) && item !== "generic"),
    );
    return families.size > 1;
  }, [products]);

  return {
    stageOutputView, keywordAnalysisByAsin, keywordEnrichmentByKeyword, ratingByAsin, salesTrendByAsin, fbaFeeByAsin,
    listingContentByAsin, categoryTrendByNode, childSalesByAsin, priceStrategyByAsin, imageRemarksByAsin,
    imageRemarkOutcomesByAsin, reviewAnalysisByAsin, reviewGapReasonCode, fbaGapReasonCode, productLaunchSources,
    trafficOverviewByAsin, trafficMonthlyTrendByAsin, trafficMeta, mixedFamilies,
  };
}
