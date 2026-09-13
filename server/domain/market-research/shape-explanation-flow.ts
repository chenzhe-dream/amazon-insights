import { z } from 'zod';
import type { CreateMarketModuleRunInput, MarketModuleRun, MarketStepDefinition } from '../../db/market-module-execution-repository';

export const MARKET_SHAPE_EXPLANATION_FLOW_VERSION = 'shape-explanation/v1';
export const MARKET_SHAPE_EXPLANATION_CATALOG_VERSION = 'market-shape-explanation-catalog/v1';

export const MarketShapeExplanationFlowParamsSchema = z.object({
  flow: z.literal(MARKET_SHAPE_EXPLANATION_FLOW_VERSION),
  parentRunId: z.string().uuid(),
  revisionId: z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/),
  explanationCatalogId: z.string().regex(/^market-shape-explanation:[a-f0-9]{64}$/),
}).strict();

export type MarketShapeExplanationFlowParams = z.infer<typeof MarketShapeExplanationFlowParamsSchema>;

export function marketShapeExplanationInitialSteps(input: Pick<CreateMarketModuleRunInput, 'params'>): MarketStepDefinition[] {
  const params = MarketShapeExplanationFlowParamsSchema.parse(input.params);
  return [{
    stepKey: `shape-explanation/prepare/${params.revisionId}/${params.explanationCatalogId}`,
    kind: 'prepare-members',
    subject: { flow: params.flow },
    input: { phase: 'prepare-shape-explanation', parentRunId: params.parentRunId, revisionId: params.revisionId, explanationCatalogId: params.explanationCatalogId },
    inputRefs: [],
  }];
}

export function isMarketShapeExplanationFlow(run: Pick<MarketModuleRun, 'moduleKind' | 'params' | 'versions' | 'collectionRevision'>) {
  const parsed = MarketShapeExplanationFlowParamsSchema.safeParse(run.params);
  return parsed.success && run.moduleKind === 'shape-price'
    && run.versions.source === MARKET_SHAPE_EXPLANATION_CATALOG_VERSION
    && run.versions.rule === MARKET_SHAPE_EXPLANATION_CATALOG_VERSION
    && run.versions.mapping === parsed.data.explanationCatalogId
    && run.versions.planner === MARKET_SHAPE_EXPLANATION_FLOW_VERSION
    && run.versions.model === 'market.semantic.text.v1'
    && !!run.versions.prompt && !!run.versions.configuration
    && run.collectionRevision === parsed.data.revisionId;
}
