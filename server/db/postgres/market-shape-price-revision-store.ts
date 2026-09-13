import { z } from 'zod';
import type { Pool } from 'pg';
import { MarketShapeRevisionRequestSchema } from '../../../shared/market-shape-price-contracts';
import type { MarketSourceEvidence } from '../../../shared/market-source-contracts';
import type { MarketExecutionActor, MarketModuleRunView } from '../market-module-execution-repository';
import { MarketExecutionConflictError } from '../market-module-execution-repository';
import { PostgresQueryContext } from './query-context';
import { PostgresMarketAnalysisSnapshotStore } from './market-analysis-snapshot-store';
import { PostgresMarketModuleExecutionStore } from './market-module-execution-store';
import { buildMarketShapePriceCatalog, createMarketShapeRevision } from '../../domain/market-research/shape-price-catalog';
import {MarketShapeCatalogVersionSchema} from '../../../shared/market-shape-structure-contracts';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
type Request = z.infer<typeof MarketShapeRevisionRequestSchema>;
type Catalog = Awaited<ReturnType<typeof buildMarketShapePriceCatalog>>;
type Row = {
    organization_id: string;
    study_id: string;
    run_id: string;
    revision_id: string;
    parent_revision_id: string | null;
    ordinal: number;
    stored_by: string;
    stored_at: Date | string;
    request_json: unknown;
    request_hash: string;
    catalog_json: Catalog;
    catalog_hash: string;
};
const actorSchema = z.object({ organizationId: z.string().uuid(), userId: z.string().uuid() }).strict();
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
function invalid(): never { throw new MarketExecutionConflictError(); }
const same = (a: unknown, b: unknown) => { if (digest(a) !== digest(b))
    invalid(); };
/** Durable numeric stage of A2. This does not claim model suggestions or
 * full-module completion. No model/provider requests occur during save or read. */
export class PostgresMarketShapePriceRevisionStore {
    private readonly context: PostgresQueryContext;
    private readonly snapshots: PostgresMarketAnalysisSnapshotStore;
    private readonly steps: PostgresMarketModuleExecutionStore;
    constructor(context: Pool | PostgresQueryContext) {
        this.context = context instanceof PostgresQueryContext ? context : new PostgresQueryContext(context);
        this.snapshots = new PostgresMarketAnalysisSnapshotStore(this.context);
        this.steps = new PostgresMarketModuleExecutionStore(this.context);
    }
    private async view(actor: MarketExecutionActor, moduleRunId: string) {
        const view = await this.steps.findModuleRun({ actor, moduleRunId });
        return view?.run.moduleKind === 'shape-price' && view.run.versions.source === 'market-source-handlers/v1' && MarketShapeCatalogVersionSchema.safeParse(view.run.versions.rule).success ? view : null;
    }
    private async calculate(actor: MarketExecutionActor, view: MarketModuleRunView, request: Request, authorId: string, createdAt: string, current: boolean) {
        const sources: Record<string, MarketSourceEvidence> = {};
        const ids = [request.referenceAttemptId, ...request.historyAttemptIds];
        if (new Set(ids).size !== ids.length)
            invalid();
        const observations = [];
        for (const id of ids) {
            const attempt = view.attempts.find(a => a.id === id), step = view.steps.find(s => s.id === attempt?.stepId);
            if (!attempt || !step || step.kind !== 'collect-product-month' || !['succeeded', 'empty'].includes(attempt.status) || (current && step.latestAttemptId !== id))
                invalid();
            const output = obj(attempt.output), input = obj(step.input);
            if (output.handlerVersion !== 'market-source-handlers/v1' || output.month !== input.month)
                invalid();
            const scope = { actor, studyId: view.run.scope.researchId };
            const saved = await this.snapshots.findInput({ ...scope, id: z.string().parse(output.inputSnapshotId) });
            const source = await this.snapshots.findSource({ ...scope, id: z.string().parse(output.sourceRef) });
            const row = (await this.context.query<{
                receipt_json: unknown;
            }>('SELECT receipt_json FROM market_analysis_step_attempts WHERE organization_id=$1 AND run_id=$2 AND id=$3', [actor.organizationId, view.run.id, id])).rows[0];
            const receipt = obj(row?.receipt_json);
            if (!saved || !source || receipt.attemptId !== id || !Array.isArray(receipt.inputIds) || !receipt.inputIds.includes(saved.snapshot.snapshotId) || !Array.isArray(receipt.sourceIds) || !receipt.sourceIds.includes(source.id))
                invalid();
            if (observations.length) {
                const basis = observations[0].snapshot.snapshotId;
                if (input.selectionInputSnapshotId !== basis || !step.inputRefs.some(r => r.kind === 'input' && r.id === basis) || !Array.isArray(input.selectedAsins))
                    invalid();
                same([...input.selectedAsins].sort(), [...saved.snapshot.expectedRecordIds].sort());
            }
            else if (input.selectedAsins !== undefined || input.selectionInputSnapshotId !== undefined)
                invalid();
            sources[source.id] = source.evidence;
            observations.push({ month: z.string().parse(output.month), snapshot: saved.snapshot, sourceRef: source.id });
        }
        const [reference, ...history] = observations;
        const revision = createMarketShapeRevision({ scope: view.run.scope, basisSnapshotId: reference.snapshot.snapshotId, parentRevisionId: request.expectedParentRevisionId,
            selectedAsins: request.selectedAsins, taxonomyVersion: request.taxonomyVersion, labels: request.labels, assignments: request.assignments, authorId, createdAt, note: request.note });
        return buildMarketShapePriceCatalog({ reference, history, sources, revision, bands: request.bands, dataCutoffAt: createdAt, version:MarketShapeCatalogVersionSchema.parse(view.run.versions.rule) });
    }
    private async restore(actor: MarketExecutionActor, view: MarketModuleRunView, row: Row) {
        const request = MarketShapeRevisionRequestSchema.parse(row.request_json);
        same(row.request_hash, digest({ actor: { organizationId: row.organization_id, userId: row.stored_by }, moduleRunId: row.run_id, request }));
        if (row.organization_id !== actor.organizationId || row.run_id !== view.run.id || row.study_id !== view.run.scope.researchId || row.revision_id !== row.catalog_json?.revision.revisionId || row.parent_revision_id !== request.expectedParentRevisionId)
            invalid();
        same(digest(row.catalog_json), row.catalog_hash);
        const catalog = await this.calculate(actor, view, request, row.stored_by, new Date(row.stored_at).toISOString(), false);
        same(catalog, row.catalog_json);
        return { ordinal: row.ordinal, catalog, semanticStatus: 'not-integrated' as const };
    }
    async save(input: {
        actor: MarketExecutionActor;
        moduleRunId: string;
        request: unknown;
        idempotencyKey: string;
    }) {
        const actor = actorSchema.parse(input.actor), moduleRunId = z.string().uuid().parse(input.moduleRunId), key = z.string().uuid().parse(input.idempotencyKey);
        const request = MarketShapeRevisionRequestSchema.parse(input.request), requestHash = digest({ actor, moduleRunId, request });
        return this.context.transaction(async () => {
            const active = await this.context.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE", [actor.userId, actor.organizationId]);
            if (!active.rowCount)
                invalid();
            await this.context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE', [moduleRunId, actor.organizationId]);
            const view = await this.view(actor, moduleRunId);
            if (!view)
                invalid();
            const prior = (await this.context.query<Row>('SELECT * FROM market_shape_price_revisions WHERE organization_id=$1 AND idempotency_key=$2', [actor.organizationId, key])).rows[0];
            if (prior) {
                if (prior.run_id !== moduleRunId || prior.request_hash !== requestHash)
                    invalid();
                return { ...await this.restore(actor, view, prior), created: false };
            }
            if (view.run.status === 'cancelled')
                invalid();
            const latest = (await this.context.query<Row>('SELECT * FROM market_shape_price_revisions WHERE organization_id=$1 AND run_id=$2 ORDER BY ordinal DESC LIMIT 1', [actor.organizationId, moduleRunId])).rows[0];
            if ((latest?.revision_id ?? null) !== request.expectedParentRevisionId)
                invalid();
            // Same run keeps the same source selection basis across manual edits.
            if (latest && MarketShapeRevisionRequestSchema.parse(latest.request_json).referenceAttemptId !== request.referenceAttemptId)
                invalid();
            const now = new Date().toISOString(), catalog = await this.calculate(actor, view, request, actor.userId, now, true), ordinal = (latest?.ordinal ?? 0) + 1;
            const inserted = await this.context.query<Row>(`INSERT INTO market_shape_price_revisions(organization_id,study_id,run_id,revision_id,parent_revision_id,ordinal,stored_by,stored_at,idempotency_key,request_json,request_hash,catalog_json,catalog_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13) RETURNING *`, [actor.organizationId, view.run.scope.researchId, moduleRunId, catalog.revision.revisionId, request.expectedParentRevisionId, ordinal, actor.userId, now, key, JSON.stringify(request), requestHash, JSON.stringify(catalog), digest(catalog)]);
            if (!inserted.rowCount)
                invalid();
            return { created: true, ordinal, catalog, semanticStatus: 'not-integrated' as const };
        });
    }
    async find(input: {
        actor: MarketExecutionActor;
        moduleRunId: string;
        revisionId?: string;
    }) {
        const actor = actorSchema.parse(input.actor), moduleRunId = z.string().uuid().parse(input.moduleRunId);
        const revisionId = z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/).optional().parse(input.revisionId);
        const view = await this.view(actor, moduleRunId);
        if (!view)
            return null;
        const row = (await this.context.query<Row>(`SELECT * FROM market_shape_price_revisions WHERE organization_id=$1 AND run_id=$2
   AND ($3::text IS NULL OR revision_id=$3) ORDER BY ordinal DESC LIMIT 1`, [actor.organizationId, moduleRunId, revisionId ?? null])).rows[0];
        return row ? this.restore(actor, view, row) : null;
    }
}
