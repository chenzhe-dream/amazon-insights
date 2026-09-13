import { z } from 'zod';
import type { MarketExecutionActor } from '../db/market-module-execution-repository';
import { MarketExecutionConflictError } from '../db/market-module-execution-repository';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketShapePriceRevisionStore } from '../db/postgres/market-shape-price-revision-store';
import { buildMarketShapeExplanationCatalog, validateMarketShapeExplanationCatalog } from '../domain/market-research/shape-explanation-catalog';
import { MARKET_SHAPE_EXPLANATION_CATALOG_VERSION, MarketShapeExplanationFlowParamsSchema, isMarketShapeExplanationFlow } from '../domain/market-research/shape-explanation-flow';

const actorSchema = z.object({ organizationId: z.string().uuid(), userId: z.string().uuid() }).strict();
const uuid4 = z.string().uuid().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
const linkSchema = z.object({
  organization_id: z.string().uuid(), study_id: z.string().uuid(), parent_run_id: uuid4,
  revision_id: z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/),
  explanation_catalog_id: z.string().regex(/^market-shape-explanation:[a-f0-9]{64}$/),
  configuration_version: z.string().min(1).max(240), child_run_id: uuid4,
  created_by: z.string().uuid(),
}).strict();

/** Restores the complete, digest-verified catalog for an authorized native child.
 * Caller-provided windows never participate in catalog selection or identity. */
export async function loadMarketShapeExplanationCatalog(
  context: PostgresQueryContext,
  actorValue: MarketExecutionActor,
  moduleRunIdValue: string,
) {
  const actor = actorSchema.parse(actorValue), moduleRunId = uuid4.parse(moduleRunIdValue);
  return context.transaction(async () => {
    const steps = new PostgresMarketModuleExecutionStore(context);
    const child = await steps.findModuleRun({ actor, moduleRunId });
    if (!child || !isMarketShapeExplanationFlow(child.run)) throw new MarketExecutionConflictError();
    await context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR SHARE', [moduleRunId, actor.organizationId]);
    const rows = (await context.query(`SELECT organization_id,study_id,parent_run_id,revision_id,explanation_catalog_id,configuration_version,child_run_id,created_by
      FROM market_shape_explanation_runs WHERE organization_id=$1 AND child_run_id=$2 LIMIT 2`, [actor.organizationId, moduleRunId])).rows;
    if (rows.length !== 1) throw new MarketExecutionConflictError();
    const link = linkSchema.parse(rows[0]), params = MarketShapeExplanationFlowParamsSchema.parse(child.run.params);
    if (link.organization_id !== actor.organizationId || link.study_id !== child.run.scope.researchId || link.child_run_id !== child.run.id
      || link.parent_run_id !== params.parentRunId || link.revision_id !== params.revisionId
      || link.explanation_catalog_id !== params.explanationCatalogId || link.configuration_version !== child.run.versions.configuration
      || link.created_by !== child.run.createdBy || child.run.versions.source !== MARKET_SHAPE_EXPLANATION_CATALOG_VERSION
      || child.run.versions.rule !== MARKET_SHAPE_EXPLANATION_CATALOG_VERSION || child.run.versions.mapping !== params.explanationCatalogId)
      throw new MarketExecutionConflictError();
    const restored = await new PostgresMarketShapePriceRevisionStore(context).find({ actor, moduleRunId: params.parentRunId, revisionId: params.revisionId });
    if (!restored || restored.catalog.scope.researchId !== link.study_id || restored.catalog.scope.organizationId !== link.organization_id)
      throw new MarketExecutionConflictError();
    const catalog = validateMarketShapeExplanationCatalog(buildMarketShapeExplanationCatalog(restored.catalog));
    if (catalog.revisionId !== params.revisionId || catalog.explanationCatalogId !== params.explanationCatalogId
      || catalog.source.catalogVersion !== restored.catalog.version) throw new MarketExecutionConflictError();
    return catalog;
  });
}
