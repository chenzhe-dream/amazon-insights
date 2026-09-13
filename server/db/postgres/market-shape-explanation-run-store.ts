import type { Pool } from 'pg';
import { z } from 'zod';
import type { MarketExecutionActor, MarketModuleRun } from '../market-module-execution-repository';
import { MarketExecutionConflictError } from '../market-module-execution-repository';
import { buildMarketShapeExplanationCatalog, validateMarketShapeExplanationCatalog } from '../../domain/market-research/shape-explanation-catalog';
import { MARKET_SHAPE_EXPLANATION_CATALOG_VERSION, MARKET_SHAPE_EXPLANATION_FLOW_VERSION, MarketShapeExplanationFlowParamsSchema, isMarketShapeExplanationFlow, marketShapeExplanationInitialSteps } from '../../domain/market-research/shape-explanation-flow';
import { PostgresQueryContext } from './query-context';
import { PostgresMarketModuleExecutionStore } from './market-module-execution-store';
import { PostgresMarketShapePriceRevisionStore } from './market-shape-price-revision-store';

const actorSchema = z.object({ organizationId: z.string().uuid(), userId: z.string().uuid() }).strict();
const identitySchema = z.object({ configurationVersion: z.string().trim().min(1).max(240), promptVersion: z.string().trim().min(1).max(240) }).strict();
const revisionIdSchema = z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/);
const uuid4 = z.string().uuid().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
type Identity = z.infer<typeof identitySchema>;

export class PostgresMarketShapeExplanationRunStore {
  private readonly context: PostgresQueryContext;
  private readonly revisions: PostgresMarketShapePriceRevisionStore;
  private readonly steps: PostgresMarketModuleExecutionStore;
  constructor(context: Pool | PostgresQueryContext) {
    this.context = context instanceof PostgresQueryContext ? context : new PostgresQueryContext(context);
    this.revisions = new PostgresMarketShapePriceRevisionStore(this.context);
    this.steps = new PostgresMarketModuleExecutionStore(this.context);
  }

  async saveRevisionAndEnsureExplanation(input: { actor: MarketExecutionActor; parentRunId: string; request: unknown; idempotencyKey: string; identity: Identity }) {
    const actor = actorSchema.parse(input.actor), parentRunId = uuid4.parse(input.parentRunId), idempotencyKey = uuid4.parse(input.idempotencyKey), identity = identitySchema.parse(input.identity);
    return this.context.transaction(async () => {
      const revision = await this.revisions.save({ actor, moduleRunId: parentRunId, request: input.request, idempotencyKey });
      const ensured = await this.#ensure(actor, parentRunId, revision, idempotencyKey, identity);
      return { revision, ...ensured };
    });
  }

  /** History lookup has no dependency on the currently configured model and
   * never creates a child. Immutable lineage binds each result to this revision. */
  async listForRevision(input:{actor:MarketExecutionActor;parentRunId:string;revisionId:string}) {
    const actor=actorSchema.parse(input.actor),parentRunId=uuid4.parse(input.parentRunId),revisionId=revisionIdSchema.parse(input.revisionId);
    const revision=await this.revisions.find({actor,moduleRunId:parentRunId,revisionId});
    if(!revision)throw new MarketExecutionConflictError();
    const rows=(await this.context.query<{child_run_id:string;status:string;created_at:Date|string}>(`
      SELECT l.child_run_id,r.status,l.created_at FROM market_shape_explanation_runs l
      JOIN market_analysis_module_runs r ON r.id=l.child_run_id AND r.organization_id=l.organization_id AND r.study_id=l.study_id
      JOIN market_analysis_module_runs p ON p.id=l.parent_run_id AND p.organization_id=l.organization_id AND p.study_id=l.study_id
      WHERE l.organization_id=$1 AND l.parent_run_id=$2 AND l.revision_id=$3
        AND r.request_json->'scope'=p.request_json->'scope'
        AND EXISTS(SELECT 1 FROM users u WHERE u.id=$4 AND u.organization_id=$1 AND u.status='active')
      ORDER BY l.created_at DESC,l.child_run_id DESC`,[actor.organizationId,parentRunId,revisionId,actor.userId])).rows;
    return rows.map(row=>({moduleRunId:uuid4.parse(row.child_run_id),status:z.enum(['queued','running','partial','succeeded','failed','cancelled']).parse(row.status),createdAt:new Date(row.created_at).toISOString()}));
  }

  async ensureExplanationForRevision(input: { actor: MarketExecutionActor; parentRunId: string; revisionId: string; idempotencyKey: string; identity: Identity }) {
    const actor = actorSchema.parse(input.actor), parentRunId = uuid4.parse(input.parentRunId), revisionId = revisionIdSchema.parse(input.revisionId), idempotencyKey = uuid4.parse(input.idempotencyKey), identity = identitySchema.parse(input.identity);
    return this.context.transaction(async () => {
      // Serializes missing-link recovery, competing creators and cancellation.
      await this.context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE', [parentRunId, actor.organizationId]);
      const revision = await this.revisions.find({ actor, moduleRunId: parentRunId, revisionId });
      if (!revision) throw new MarketExecutionConflictError();
      const ensured = await this.#ensure(actor, parentRunId, revision, idempotencyKey, identity);
      return { revision, ...ensured };
    });
  }

  async #ensure(actor: MarketExecutionActor, parentRunId: string, revision: NonNullable<Awaited<ReturnType<PostgresMarketShapePriceRevisionStore['find']>>>, idempotencyKey: string, identity: Identity) {
    const parent = await this.steps.findModuleRun({ actor, moduleRunId: parentRunId });
    if (!parent) throw new MarketExecutionConflictError();
    const explanationCatalog = validateMarketShapeExplanationCatalog(buildMarketShapeExplanationCatalog(revision.catalog));
    const params = { flow: MARKET_SHAPE_EXPLANATION_FLOW_VERSION, parentRunId, revisionId: revision.catalog.revision.revisionId, explanationCatalogId: explanationCatalog.explanationCatalogId };
    const linked = (await this.context.query<{ child_run_id: string }>('SELECT child_run_id FROM market_shape_explanation_runs WHERE organization_id=$1 AND parent_run_id=$2 AND revision_id=$3 AND configuration_version=$4', [actor.organizationId, parentRunId, params.revisionId, identity.configurationVersion])).rows[0];
    if (!linked && parent.run.status === 'cancelled') throw new MarketExecutionConflictError();
    const request = { actor, scope: revision.catalog.scope, moduleKind: 'shape-price' as const, params,
      versions: { source: MARKET_SHAPE_EXPLANATION_CATALOG_VERSION, rule: MARKET_SHAPE_EXPLANATION_CATALOG_VERSION, mapping: explanationCatalog.explanationCatalogId, planner: MARKET_SHAPE_EXPLANATION_FLOW_VERSION, model: 'market.semantic.text.v1', prompt: identity.promptVersion, configuration: identity.configurationVersion },
      collectionRevision: params.revisionId, idempotencyKey, initialSteps: marketShapeExplanationInitialSteps({ params }) };
    const created = await this.steps.createModuleRun(request);
    if (!isMarketShapeExplanationFlow(created.run)) throw new MarketExecutionConflictError();
    if (linked) {
      if (linked.child_run_id !== created.run.id || created.run.versions.prompt !== identity.promptVersion
        || MarketShapeExplanationFlowParamsSchema.parse(created.run.params).explanationCatalogId !== params.explanationCatalogId) throw new MarketExecutionConflictError();
      return { explanationCatalog, childRun: created.run, created: false };
    }
    await this.context.query(`INSERT INTO market_shape_explanation_runs(organization_id,study_id,parent_run_id,revision_id,explanation_catalog_id,configuration_version,child_run_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,parent_run_id,revision_id,configuration_version) DO NOTHING`,
      [actor.organizationId, revision.catalog.scope.researchId, parentRunId, params.revisionId, params.explanationCatalogId, identity.configurationVersion, created.run.id, created.run.createdBy]);
    const savedLink = (await this.context.query<{ child_run_id: string }>('SELECT child_run_id FROM market_shape_explanation_runs WHERE organization_id=$1 AND parent_run_id=$2 AND revision_id=$3 AND configuration_version=$4', [actor.organizationId, parentRunId, params.revisionId, identity.configurationVersion])).rows[0];
    if (!savedLink || savedLink.child_run_id !== created.run.id) throw new MarketExecutionConflictError();
    return { explanationCatalog, childRun: created.run as MarketModuleRun, created: created.created };
  }
}
