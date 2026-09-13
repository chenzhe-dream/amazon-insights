import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresMarketShapeExplanationRunStore } from '../../server/db/postgres/market-shape-explanation-run-store';
import { marketShapeExplanationInitialSteps } from '../../server/domain/market-research/shape-explanation-flow';
import { loadMarketShapeExplanationCatalog } from '../../server/services/market-shape-explanation-input-service';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { createMarketShapeExplanationRunFixture } from './helpers/market-shape-explanation-run-fixture';

const identity = { configurationVersion: 'shape-input-config/v1', promptVersion: 'shape-input-prompt/v1' };

test('shape explanation catalog loader restores authorized immutable child lineage', { timeout: 120_000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close());
  await runPostgresMigrations(pg.pool);

  await t.test('loads the exact linked revision and does not drift to a newer revision', async () => {
    const f = await createMarketShapeExplanationRunFixture(pg.pool), store = new PostgresMarketShapeExplanationRunStore(f.context);
    const first = await store.saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId, request: f.request, idempotencyKey: randomUUID(), identity });
    const second = await store.saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId, request: { ...f.request, expectedParentRevisionId: first.revision.catalog.revision.revisionId, note: 'newer revision' }, idempotencyKey: randomUUID(), identity });
    const loaded = await loadMarketShapeExplanationCatalog(f.context, f.actor, first.childRun.id);
    assert.equal(loaded.revisionId, first.revision.catalog.revision.revisionId);
    assert.equal(loaded.explanationCatalogId, first.explanationCatalog.explanationCatalogId);
    assert.notEqual(loaded.revisionId, second.revision.catalog.revision.revisionId);
    assert.deepEqual(loaded, first.explanationCatalog);
  });

  await t.test('remains readable after parent cancellation but rejects another organization', async () => {
    const f = await createMarketShapeExplanationRunFixture(pg.pool), store = new PostgresMarketShapeExplanationRunStore(f.context);
    const saved = await store.saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId, request: f.request, idempotencyKey: randomUUID(), identity });
    await f.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.parentRunId, idempotencyKey: randomUUID() });
    assert.equal((await loadMarketShapeExplanationCatalog(f.context, f.actor, saved.childRun.id)).explanationCatalogId, saved.explanationCatalog.explanationCatalogId);
    const foreign = { organizationId: randomUUID(), userId: randomUUID() };
    await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Foreign loader','member','active',now(),now())", [foreign.userId, foreign.organizationId, `${foreign.userId}@example.com`]);
    await assert.rejects(loadMarketShapeExplanationCatalog(f.context, foreign, saved.childRun.id));
  });

  await t.test('rejects a shape revision without an immutable child link', async () => {
    const f = await createMarketShapeExplanationRunFixture(pg.pool);
    const revision = await f.revisions.save({ actor: f.actor, moduleRunId: f.parentRunId, request: f.request, idempotencyKey: randomUUID() });
    await assert.rejects(loadMarketShapeExplanationCatalog(f.context, f.actor, f.parentRunId));
    assert.ok(revision.catalog.revision.revisionId);
  });

  await t.test('detects privileged tampering of link catalog and configuration while PostgreSQL rejects a false parent', async () => {
    const f = await createMarketShapeExplanationRunFixture(pg.pool), store = new PostgresMarketShapeExplanationRunStore(f.context);
    const saved = await store.saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId, request: f.request, idempotencyKey: randomUUID(), identity });
    const cases: Array<[string, unknown]> = [
      ['explanation_catalog_id', 'market-shape-explanation:' + 'd'.repeat(64)],
      ['configuration_version', 'tampered-config/v1'],
    ];
    for (const [column, value] of cases) {
      await pg.pool.query('ALTER TABLE market_shape_explanation_runs DISABLE TRIGGER USER');
      await pg.pool.query(`UPDATE market_shape_explanation_runs SET ${column}=$1 WHERE child_run_id=$2`, [value, saved.childRun.id]);
      await pg.pool.query('ALTER TABLE market_shape_explanation_runs ENABLE TRIGGER USER');
      await assert.rejects(loadMarketShapeExplanationCatalog(f.context, f.actor, saved.childRun.id), column);
      await pg.pool.query('ALTER TABLE market_shape_explanation_runs DISABLE TRIGGER USER');
      await pg.pool.query(`UPDATE market_shape_explanation_runs SET ${column}=$1 WHERE child_run_id=$2`, [column === 'explanation_catalog_id' ? saved.explanationCatalog.explanationCatalogId : identity.configurationVersion, saved.childRun.id]);
      await pg.pool.query('ALTER TABLE market_shape_explanation_runs ENABLE TRIGGER USER');
    }
    await pg.pool.query('ALTER TABLE market_shape_explanation_runs DISABLE TRIGGER USER');
    await assert.rejects(pg.pool.query('UPDATE market_shape_explanation_runs SET parent_run_id=$1 WHERE child_run_id=$2', [randomUUID(), saved.childRun.id]));
    await pg.pool.query('ALTER TABLE market_shape_explanation_runs ENABLE TRIGGER USER');
  });

  await t.test('rejects a mutually consistent forged child and link catalog by rebuilding the parent revision', async () => {
    const f = await createMarketShapeExplanationRunFixture(pg.pool), store = new PostgresMarketShapeExplanationRunStore(f.context);
    const saved = await store.saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId, request: f.request, idempotencyKey: randomUUID(), identity });
    const revisionId = saved.revision.catalog.revision.revisionId, fakeCatalogId = 'market-shape-explanation:' + 'e'.repeat(64);
    const params = { flow: 'shape-explanation/v1' as const, parentRunId: f.parentRunId, revisionId, explanationCatalogId: fakeCatalogId };
    const fake = await f.steps.createModuleRun({ actor: f.actor, scope: f.scope, moduleKind: 'shape-price', params,
      versions: { source: 'market-shape-explanation-catalog/v1', rule: 'market-shape-explanation-catalog/v1', mapping: fakeCatalogId, planner: 'shape-explanation/v1', model: 'market.semantic.text.v1', prompt: 'fake-prompt/v1', configuration: 'fake-config/v1' },
      collectionRevision: revisionId, idempotencyKey: randomUUID(), initialSteps: marketShapeExplanationInitialSteps({ params }) });
    await pg.pool.query(`INSERT INTO market_shape_explanation_runs(organization_id,study_id,parent_run_id,revision_id,explanation_catalog_id,configuration_version,child_run_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [f.actor.organizationId, f.scope.researchId, f.parentRunId, revisionId, fakeCatalogId, 'fake-config/v1', fake.run.id, f.actor.userId]);
    await assert.rejects(loadMarketShapeExplanationCatalog(f.context, f.actor, fake.run.id));
  });
});
