import { z } from 'zod';
import type { Pool } from 'pg';
import { MarketKeywordRevisionCatalogSchema, MarketKeywordRevisionIdSchema, MarketKeywordRevisionRequestSchema } from '../../../shared/market-keyword-revision-contracts';
import type { MarketExecutionActor, MarketModuleRunView } from '../market-module-execution-repository';
import { MarketExecutionConflictError } from '../market-module-execution-repository';
import { PostgresQueryContext } from './query-context';
import { PostgresMarketModuleExecutionStore } from './market-module-execution-store';
import { buildMarketKeywordRevision } from '../../domain/market-research/keyword-revision';
import { isMarketKeywordFlow } from '../../domain/market-research/keyword-flow';
import { readMarketKeywordRun } from '../../services/market-keyword-read-service';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
const actorSchema = z.object({ organizationId: z.string().uuid(), userId: z.string().uuid() }).strict();
type Row = { organization_id: string; study_id: string; run_id: string; revision_id: string; parent_revision_id: string | null;
  ordinal: number; stored_by: string; stored_at: Date | string; idempotency_key: string; request_json: unknown; request_hash: string; catalog_json: unknown; catalog_hash: string };
function invalid(): never { throw new MarketExecutionConflictError(); }
function same(a: unknown, b: unknown) { if (digest(a) !== digest(b)) invalid(); }
/** Revisions retain their own facts. Historical reads and command ACK replay never
 * reread current source/model facts and never trigger collection or model work. */
export class PostgresMarketKeywordRevisionStore {
  private readonly context: PostgresQueryContext;
  private readonly steps: PostgresMarketModuleExecutionStore;
  constructor(context: Pool | PostgresQueryContext) {
    this.context = context instanceof PostgresQueryContext ? context : new PostgresQueryContext(context);
    this.steps = new PostgresMarketModuleExecutionStore(this.context);
  }
  private async view(actor: MarketExecutionActor, moduleRunId: string) {
    const view = await this.steps.findModuleRun({ actor, moduleRunId });
    return view && view.run.moduleKind === 'keywords' && isMarketKeywordFlow(view.run) ? view : null;
  }
  private restore(actor: MarketExecutionActor, view: MarketModuleRunView, row: Row) {
    try {
      const request = MarketKeywordRevisionRequestSchema.parse(row.request_json), stored = MarketKeywordRevisionCatalogSchema.parse(row.catalog_json);
      z.string().uuid().parse(row.stored_by); z.string().uuid().parse(row.idempotency_key);
      z.number().int().min(1).max(2147483647).parse(row.ordinal);
      const createdAt = new Date(row.stored_at).toISOString();
      if (row.organization_id !== actor.organizationId || row.run_id !== view.run.id || row.study_id !== view.run.scope.researchId
        || stored.facts.moduleRunId !== row.run_id || stored.facts.scope.organizationId !== row.organization_id || stored.facts.scope.researchId !== row.study_id
        || row.revision_id !== stored.revision.revisionId || row.parent_revision_id !== request.expectedParentRevisionId
        || stored.revision.parentRevisionId !== row.parent_revision_id || stored.revision.authorId !== row.stored_by || stored.revision.createdAt !== createdAt
        || (row.ordinal === 1) !== (row.parent_revision_id === null)) invalid();
      same(stored.facts.scope, view.run.scope);
      same(row.request_json, request); same(row.catalog_json, stored);
      if (row.request_hash !== digest({ actor: { organizationId: row.organization_id, userId: row.stored_by }, moduleRunId: row.run_id, request })
        || row.catalog_hash !== digest(row.catalog_json)) invalid();
      const catalog = buildMarketKeywordRevision({ facts: stored.facts, request, authorId: row.stored_by, createdAt });
      same(catalog, stored);
      return { ordinal: row.ordinal, catalog };
    } catch { return invalid(); }
  }
  async save(input: { actor: MarketExecutionActor; moduleRunId: string; request: unknown; idempotencyKey: string }) {
    const actor = actorSchema.parse(input.actor), moduleRunId = z.string().uuid().parse(input.moduleRunId), key = z.string().uuid().parse(input.idempotencyKey);
    const request = MarketKeywordRevisionRequestSchema.parse(input.request), requestHash = digest({ actor, moduleRunId, request });
    try { return await this.context.transaction(async () => {
      const active = await this.context.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE", [actor.userId, actor.organizationId]);
      if (!active.rowCount) invalid();
      const locked = await this.context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE', [moduleRunId, actor.organizationId]);
      if (!locked.rowCount) invalid();
      const view = await this.view(actor, moduleRunId); if (!view) invalid();
      const prior = (await this.context.query<Row>('SELECT * FROM market_keyword_revisions WHERE organization_id=$1 AND idempotency_key=$2', [actor.organizationId, key])).rows[0];
      if (prior) {
        if (prior.run_id !== moduleRunId || prior.request_hash !== requestHash || prior.stored_by !== actor.userId) invalid();
        return { created: false, ...this.restore(actor, view, prior) };
      }
      if (view.run.status === 'cancelled') invalid();
      const latest = (await this.context.query<Row>('SELECT * FROM market_keyword_revisions WHERE organization_id=$1 AND run_id=$2 ORDER BY ordinal DESC LIMIT 1', [actor.organizationId, moduleRunId])).rows[0];
      if ((latest?.revision_id ?? null) !== request.expectedParentRevisionId) invalid();
      if (latest) this.restore(actor, view, latest);
      const current = await readMarketKeywordRun(this.context, actor, moduleRunId), facts = current?.run.facts;
      if (!facts || facts.factsId !== request.factsId) invalid();
      const now = new Date().toISOString();
      let catalog;
      try { catalog = buildMarketKeywordRevision({ facts, request, authorId: actor.userId, createdAt: now }); } catch { return invalid(); }
      const ordinal = (latest?.ordinal ?? 0) + 1;
      const inserted = await this.context.query<Row>(`INSERT INTO market_keyword_revisions(organization_id,study_id,run_id,revision_id,parent_revision_id,ordinal,stored_by,stored_at,idempotency_key,request_json,request_hash,catalog_json,catalog_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13) RETURNING *`,
        [actor.organizationId, view.run.scope.researchId, moduleRunId, catalog.revision.revisionId, request.expectedParentRevisionId, ordinal, actor.userId, now, key, JSON.stringify(request), requestHash, JSON.stringify(catalog), digest(catalog)]);
      if (!inserted.rowCount) invalid();
      return { created: true, ...this.restore(actor, view, inserted.rows[0]) };
    }); } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') invalid();
      throw error;
    }
  }
  async find(input: { actor: MarketExecutionActor; moduleRunId: string; revisionId: string }) {
    const actor = actorSchema.parse(input.actor), moduleRunId = z.string().uuid().parse(input.moduleRunId), revisionId = MarketKeywordRevisionIdSchema.parse(input.revisionId);
    const view = await this.view(actor, moduleRunId); if (!view) return null;
    const row = (await this.context.query<Row>('SELECT * FROM market_keyword_revisions WHERE organization_id=$1 AND run_id=$2 AND revision_id=$3', [actor.organizationId, moduleRunId, revisionId])).rows[0];
    return row ? this.restore(actor, view, row) : null;
  }
  async list(input: { actor: MarketExecutionActor; moduleRunId: string }) {
    const actor = actorSchema.parse(input.actor), moduleRunId = z.string().uuid().parse(input.moduleRunId);
    const view = await this.view(actor, moduleRunId); if (!view) return [];
    const rows = (await this.context.query<Row>('SELECT * FROM market_keyword_revisions WHERE organization_id=$1 AND run_id=$2 ORDER BY ordinal', [actor.organizationId, moduleRunId])).rows;
    let parent: string | null = null;
    return rows.map((row, index) => {
      const { ordinal, catalog } = this.restore(actor, view, row);
      if (ordinal !== index + 1 || catalog.revision.parentRevisionId !== parent) invalid();
      parent = catalog.revision.revisionId;
      return { revisionId: catalog.revision.revisionId, parentRevisionId: catalog.revision.parentRevisionId, ordinal,
        createdAt: catalog.revision.createdAt, factsId: catalog.facts.factsId };
    });
  }
}
