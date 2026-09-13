import type {MarketAnalysisScope} from './market-analysis-contracts';
import type {MarketOverviewAnalysis, MarketOverviewAnalysisBrief} from './market-overview-analysis-contracts';
import type {MarketSemanticRecord} from './market-semantic-contracts';

type Overview = Extract<MarketSemanticRecord, {task: 'market-overview-explanation'}>;
type Immutable<T> = T extends object ? {readonly [K in keyof T]: Immutable<T[K]>} : T;

/** A leaf is one returned dimension section, not an entire model window.
 * Primary coverage belongs to the manifest; covered IDs include local context.
 * Run identifiers record provenance references, not authorization attestations. */
export type MarketOverviewSynthesisLeaf = Immutable<{
  leafId: string;
  inputSnapshotId: string;
  attemptId: string;
  agentRunId: string;
  dimensionId: string;
  primaryFactIds: string[];
  primaryGapIds: string[];
  coveredFactIds: string[];
  coveredGapIds: string[];
  section: MarketOverviewAnalysis['dimensions'][number];
}>;

/** Complete, immutable evidence for a future bounded synthesis planner.
 * This is not a provider request or a final synthesis result. */
export type MarketOverviewSynthesisBasis = Immutable<{
  version: 'market-overview-synthesis-basis/v1';
  basisId: string;
  contentHash: string;
  scope: MarketAnalysisScope;
  catalogSnapshotId: string;
  catalogContentHash: string;
  planContentHash: string;
  numericInputSnapshotId: string;
  dataCutoffAt: string;
  selectionRevision: string;
  configurationVersion: string;
  scopeStatement: string;
  dimensions: MarketOverviewAnalysisBrief['dimensions'];
  facts: Overview['facts'];
  gaps: Overview['gaps'];
  metrics: Overview['metrics'];
  factLabels: MarketOverviewAnalysisBrief['factLabels'];
  leaves: MarketOverviewSynthesisLeaf[];
}>;
