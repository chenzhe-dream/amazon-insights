import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresQueryContext } from '../../server/db/postgres/query-context';
import { PostgresMarketAnalysisSnapshotStore } from '../../server/db/postgres/market-analysis-snapshot-store';
import { PostgresMarketModuleExecutionStore } from '../../server/db/postgres/market-module-execution-store';
import { PostgresMarketShapePriceRevisionStore } from '../../server/db/postgres/market-shape-price-revision-store';
import { createMarketSourceStepHandlers } from '../../server/runtime/market-source-step-handlers';
import { MarketModuleStepWorker } from '../../server/runtime/market-module-step-worker';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import type { RemoteMcpConnector } from '../../server/connectors/connector-contract';
test('manual shape revisions recompute from native stored sources and survive concurrent saves and reopening', { timeout: 120000 }, async (t) => {
    const pg = await startPostgresTestContainer();
    t.after(() => pg.close());
    await runPostgresMigrations(pg.pool);
    const context = new PostgresQueryContext(pg.pool), snapshots = new PostgresMarketAnalysisSnapshotStore(context), steps = new PostgresMarketModuleExecutionStore(context);
    const store = new PostgresMarketShapePriceRevisionStore(context), actor = { organizationId: randomUUID(), userId: randomUUID() }, other = { organizationId: randomUUID(), userId: randomUUID() };
    for (const a of [actor, other])
        await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Shape fixture','member','active',now(),now())", [a.userId, a.organizationId, `${a.userId}@example.com`]);
    const scope = { organizationId: actor.organizationId, researchId: randomUUID(), marketplace: 'US' as const, nodeIdPath: '1:2:3', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
    await snapshots.createStudy({ actor, scope, idempotencyKey: randomUUID(), now: new Date().toISOString() });
    let physicalCalls = 0;
    const asins = ['B000000001', 'B000000002'];
    const connector: RemoteMcpConnector = { id: 'sellerSprite', probe: async () => { throw Error('unused'); }, execute: async (request) => {
            physicalCalls++;
            const month = (request.input as any).request.month;
            return { data: { code: 'OK', marketplace: 'US', nodeIdPath: scope.nodeIdPath, month, currency: 'USD', data: asins.map((asin, i) => ({ asin, title: 'Synthetic lamp', brand: 'Fixture', price: month === '202608' ? 5 + i * 10 : 999, totalUnits: i ? 10 : 100, totalRevenue: 0, ranking: i + 1, rating: 4, ratings: 20, sellerName: 'Fixture', sellerType: 'FBA', shelfDate: '2025-01-10' })) }, source: { connectorId: 'sellerSprite', operation: request.operation, fetchedAt: new Date().toISOString(), attemptCount: 1 } };
        } };
    const handlers = createMarketSourceStepHandlers({ context, connectors: { sellerSprite: connector, sorftime: { ...connector, id: 'sorftime' } } });
    const worker = new MarketModuleStepWorker({ steps, handlers: { ...handlers, 'collect-product-month': async (input) => {
                const work = await handlers['collect-product-month'](input);
                if ((input.claim.step.input as any).month === '2026-08' && work.kind === 'settlement' && work.value.outcome.status === 'succeeded') {
                    const basis = (work.value.outcome.output as any).inputSnapshotId;
                    work.value.children = [{ stepKey: 'history/2026-07', kind: 'collect-product-month', subject: {}, input: { month: '2026-07', poolSize: 2, newProductMonths: 6, selectedAsins: asins, selectionInputSnapshotId: basis }, inputRefs: [{ kind: 'input', id: basis }] }];
                }
                return work;
            } } });
    t.after(() => worker.stop());
    const { run } = await steps.createModuleRun({ actor, scope, moduleKind: 'shape-price', params: {}, versions: { source: 'market-source-handlers/v1', rule: 'market-shape-price-catalog/v1', mapping: 'synthetic/v1', planner: 'synthetic/v1', model: null, prompt: null, configuration: null }, collectionRevision: 'initial/v1', idempotencyKey: randomUUID(), initialSteps: [{ stepKey: 'reference', kind: 'collect-product-month', subject: {}, input: { month: '2026-08', poolSize: 100, newProductMonths: 6 }, inputRefs: [] }] });
    await worker.tick();
    let view = (await steps.findModuleRun({ actor, moduleRunId: run.id }))!;
    const reference = view.attempts[0];
    assert.equal(reference.status, 'succeeded');
    await worker.tick();
    view = (await steps.findModuleRun({ actor, moduleRunId: run.id }))!;
    const history = view.attempts.find(a => a.id !== reference.id)!;
    assert.equal(history.status, 'succeeded');
    const request = { referenceAttemptId: reference.id, historyAttemptIds: [history.id], expectedParentRevisionId: null, selectedAsins: asins, taxonomyVersion: 'synthetic/v1', labels: [{ labelId: 'shelf', label: '层架灯', definition: '人工确认的层架灯' }], assignments: [{ asin: asins[0], labelId: 'shelf' }], bands: [{ id: 'low', minInclusive: 0, maxExclusive: 10 }, { id: 'high', minInclusive: 10, maxExclusive: null }], note: 'Synthetic manual decision' };
    const input = { actor, moduleRunId: run.id, request, idempotencyKey: randomUUID() };
    let first: Awaited<ReturnType<typeof store.save>>;
    await t.test('save is idempotent, rejects client authorship, and does not recollect sources', async () => {
        const saved = await Promise.all([store.save(input), store.save(input)]);
        first = saved[0];
        assert.equal(saved.filter(s => s.created).length, 1);
        assert.equal(saved[0].catalog.catalogId, saved[1].catalog.catalogId);
        assert.equal(first.catalog.revision.authorId, actor.userId);
        assert.equal(first.catalog.analysis.totals.totalUnits, 220);
        assert.equal(first.catalog.analysis.shapes.find(s => s.shape === 'shelf')!.totals.totalUnits, 200);
        assert.equal(physicalCalls, 2);
        assert.equal(first.semanticStatus, 'not-integrated');
        await assert.rejects(store.save({ ...input, request: { ...request, authorId: other.userId }, idempotencyKey: randomUUID() }));
        await assert.rejects(store.save({ ...input, request: { ...request, note: 'changed command' } }));
    });
    await t.test('optimistic parent checks allow one concurrent edit and keep the old report', async () => {
        const parent = first.catalog.revision.revisionId;
        const edits = await Promise.allSettled(['one', 'two'].map(note => store.save({ ...input, idempotencyKey: randomUUID(), request: { ...request, expectedParentRevisionId: parent, note, assignments: [{ asin: asins[1], labelId: 'shelf' }] } })));
        assert.equal(edits.filter(e => e.status === 'fulfilled').length, 1);
        assert.equal(edits.filter(e => e.status === 'rejected').length, 1);
        const restarted = new PostgresMarketShapePriceRevisionStore(new PostgresQueryContext(pg.pool));
        const old = await restarted.find({ actor, moduleRunId: run.id, revisionId: parent }), latest = await restarted.find({ actor, moduleRunId: run.id });
        assert.equal(digest(old!.catalog), digest(first.catalog));
        assert.equal(latest!.ordinal, 2);
        assert.equal(latest!.catalog.analysis.shapes.find(s => s.shape === 'shelf')!.totals.totalUnits, 20);
        assert.equal(physicalCalls, 2);
        assert.equal(await restarted.find({ actor: other, moduleRunId: run.id }), null);
        await assert.rejects(store.save({ ...input, actor: other, idempotencyKey: randomUUID() }));
        await assert.rejects(pg.pool.query('UPDATE market_shape_price_revisions SET catalog_json=$1 WHERE run_id=$2', [{}, run.id]), /immutable/i);
        await assert.rejects(pg.pool.query('DELETE FROM market_shape_price_revisions WHERE run_id=$1', [run.id]), /immutable/i);
    });
    await t.test('unknown and foreign source attempts cannot become a saved revision', async () => {
        const latest = (await store.find({ actor, moduleRunId: run.id }))!;
        await assert.rejects(store.save({ ...input, idempotencyKey: randomUUID(), request: { ...request, expectedParentRevisionId: latest.catalog.revision.revisionId, historyAttemptIds: [randomUUID()] } }));
        assert.equal((await store.find({ actor, moduleRunId: run.id }))!.ordinal, 2);
    });
    await t.test('cancelled runs retain history but cannot accept new edits; inactive users cannot read', async () => {
        await steps.cancelModuleRun({ actor, moduleRunId: run.id, idempotencyKey: randomUUID() });
        const latest = await store.find({ actor, moduleRunId: run.id });
        assert.ok(latest);
        await assert.rejects(store.save({ ...input, idempotencyKey: randomUUID(), request: { ...request, expectedParentRevisionId: latest.catalog.revision.revisionId } }));
        await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [actor.userId]);
        assert.equal(await store.find({ actor, moduleRunId: run.id }), null);
    });
});
