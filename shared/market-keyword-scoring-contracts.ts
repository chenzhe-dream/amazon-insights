import type { MarketAnalysisScope } from "./market-analysis-contracts";
import type { KeywordClusterAggregation, KeywordClusterMapping } from "../server/domain/market-research/keyword-clusters";

export const KEYWORD_SCORING_RULE_VERSION = "keyword-pvs/2.0.0" as const;

/** Scope identifies a single completed source month. Services still own authorization. */
export interface KeywordMetricEvidence {
  readonly scope: MarketAnalysisScope;
  readonly snapshotId: string;
  readonly sourceVersion: string;
  readonly recordIds: readonly string[];
  readonly metric: string;
  readonly unit: "count" | "fraction" | "ratio" | "USD" | "GBP" | "EUR" | "JPY" | "CAD" | "label";
  readonly method: string;
  readonly methodVersion: string;
}

/** Known values require evidence; missing values require a reason, never a placeholder zero. */
export interface KeywordScoringMetric {
  readonly value: number | null;
  readonly evidence: KeywordMetricEvidence | null;
  readonly missingReason: string | null;
}

export interface KeywordScoringMember {
  readonly id: string;
  readonly text: string;
  readonly searchVolume: KeywordScoringMetric;
  readonly cpc: KeywordScoringMetric;
  readonly yoyGrowth: KeywordScoringMetric;
  /** Single-month change, retained for provenance only; NEVER the legacy three-month input. */
  readonly recentGrowth: KeywordScoringMetric;
}

export interface KeywordClusterScoringMetrics {
  readonly clusterId: string;
  readonly memberIds: readonly string[];
  readonly threeMonthGrowth: KeywordScoringMetric;
  readonly supplyDemandRatio: KeywordScoringMetric;
  readonly abaTop3Share: KeywordScoringMetric;
  readonly spr: KeywordScoringMetric;
  readonly suggestedBid: KeywordScoringMetric;
  readonly averagePrice: KeywordScoringMetric;
  readonly w5: {
    readonly diagnosis: "structural_declining" | "structural_declining_seasonal_dip" | null;
    readonly evidence: KeywordMetricEvidence | null;
    readonly missingReason: string | null;
  };
}

export interface KeywordDemandScoringInput {
  readonly scope: MarketAnalysisScope;
  readonly snapshotId: string;
  readonly sourceVersion: string;
  readonly mappingVersion: string;
  readonly ruleVersion: typeof KEYWORD_SCORING_RULE_VERSION;
  readonly abaShareKind: "top3-click-share" | "top3-conversion-share";
  readonly keywords: readonly KeywordScoringMember[];
  readonly mappings: readonly KeywordClusterMapping[];
  readonly clusterMetrics: readonly KeywordClusterScoringMetrics[];
  readonly comparisonClusterIds: readonly string[];
  readonly excludedClusters: readonly { readonly clusterId: string; readonly reason: string }[];
  /** Adds completeness to the SAME validation, without weakening type/scope checks in default mode. */
  readonly requireCompleteInputs?: boolean;
}

export type KeywordScoreComponent = "S1" | "S2" | "S3" | "S4" | "S5";
export type KeywordRankField = "searchVolume" | "growth" | "supplyDemandRatio" | "abaTop3Share" | "spr" | "suggestedBid" | "averagePrice";
export type KeywordQuadrant = "main-battlefield" | "red-ocean" | "opportunity-gap" | "defer-zone";
/** Exact canonical-decimal arithmetic evidence; decimal strings keep JSON serialization lossless. */
export interface KeywordExactFraction { readonly numerator: string; readonly denominator: string; }
export interface KeywordMetricRank {
  readonly valuePercent: number | null;
  readonly exactValuePercent: KeywordExactFraction | null;
  readonly method: "mid-rank";
  readonly direction: "higher" | "lower";
  readonly comparisonClusterIds: readonly string[];
  readonly missingClusterIds: readonly string[];
  readonly singleSample: boolean;
  readonly allEqual: boolean;
  readonly discriminating: boolean;
  readonly reason: "empty-pool" | "missing-target" | null;
}

export interface KeywordClusterScore {
  readonly clusterId: string;
  readonly memberIds: readonly string[];
  readonly growth: {
    readonly value: number | null;
    /** Rankings use this exact value; value is its nearest IEEE-754 display number. */
    readonly exactValue: KeywordExactFraction | null;
    readonly unit: "fraction";
    readonly basis: "yoy-and-three-month" | "yoy-only" | "three-month-only" | "missing";
    readonly missingFields: readonly ("yoyGrowth" | "threeMonthGrowth")[];
  };
  readonly ranks: Readonly<Record<KeywordRankField, KeywordMetricRank>>;
  readonly scores: Readonly<Record<KeywordScoreComponent, number | null>>;
  readonly exactScores: Readonly<Record<KeywordScoreComponent, KeywordExactFraction | null>>;
  readonly scoreUnit: "percent";
  readonly pvs: number | null;
  readonly exactPvs: KeywordExactFraction | null;
  readonly status: "computed" | "pending";
  readonly missingComponents: readonly KeywordScoreComponent[];
  readonly quadrant: KeywordQuadrant | null;
  readonly demandClass: "mainstream" | "niche" | "observation" | null;
  readonly keywordValidationTier: "P1" | "P2" | "P3" | "P4" | null;
  readonly tierReasons: readonly string[];
  readonly searchVolumeSharePercent: number | null;
  readonly searchVolumeShareDenominator: number | null;
  readonly limitations: readonly string[];
}

export interface KeywordDemandScoreReport {
  readonly schemaVersion: "keyword-demand-score/v1";
  readonly precisionPolicy: "canonical-decimal-input/exact-rational-comparison";
  readonly input: KeywordDemandScoringInput;
  readonly aggregation: KeywordClusterAggregation;
  readonly clusters: readonly KeywordClusterScore[];
  readonly interpretation: "Historical heuristic validation ranking; not probability, profit or VOC priority";
  readonly priceScoreMeaning: "Relative selling-price position; not margin";
}
