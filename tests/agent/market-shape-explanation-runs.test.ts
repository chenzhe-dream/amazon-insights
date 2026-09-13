import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresMarketShapeExplanationRunStore } from '../../server/db/postgres/market-shape-explanation-run-store';
import { isMarketShapeExplanationFlow, marketShapeExplanationInitialSteps, MarketShapeExplanationFlowParamsSchema } from '../../server/domain/market-research/shape-explanation-flow';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { createMarketShapeExplanationRunFixture } from './helpers/market-shape-explanation-run-fixture';

const identity = { configurationVersion: 'shape-explanation-config/v1', promptVersion: 'shape-explanation-prompt/v1' };

test('shape explanation revision children are atomic, immutable, isolated and idempotent', { timeout: 120_000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close());
  await runPostgresMigrations(pg.pool);
  const f = await createMarketShapeExplanationRunFixture(pg.pool);
  const store = new PostgresMarketShapeExplanationRunStore(f.context);

  await t.test('a failed link rolls back both the revision and child queue', async () => {
    await pg.pool.query("CREATE FUNCTION reject_shape_explanation_link() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejection'; END $$");
    await pg.pool.query('CREATE TRIGGER reject_shape_explanation_link BEFORE INSERT ON market_shape_explanation_runs FOR EACH ROW EXECUTE FUNCTION reject_shape_explanation_link()');
    await assert.rejects(store.saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId, request: f.request, idempotencyKey: randomUUID(), identity }));
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_shape_price_revisions WHERE run_id=$1', [f.parentRunId])).rows[0].count, '0');
    assert.equal((await pg.pool.query("SELECT count(*) FROM market_analysis_module_runs WHERE request_json->'params'->>'flow'='shape-explanation/v1'")).rows[0].count, '0');
    await pg.pool.query('DROP TRIGGER reject_shape_explanation_link ON market_shape_explanation_runs');
    await pg.pool.query('DROP FUNCTION reject_shape_explanation_link()');
  });

  let first: Awaited<ReturnType<typeof store.saveRevisionAndEnsureExplanation>>;
  await t.test('concurrent identical commands create one revision, child and link', async () => {
    const key = randomUUID();
    const values = await Promise.all([1, 2].map(() => store.saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId, request: f.request, idempotencyKey: key, identity })));
    first = values[0];
    assert.equal(values[0].childRun.id, values[1].childRun.id);
    assert.equal(values[0].revision.catalog.revision.revisionId, values[1].revision.catalog.revision.revisionId);
    const view = await f.steps.findModuleRun({ actor: f.actor, moduleRunId: first.childRun.id });
    assert.ok(view && isMarketShapeExplanationFlow(view.run));
    assert.deepEqual(MarketShapeExplanationFlowParamsSchema.parse(view.run.params), { flow: 'shape-explanation/v1', parentRunId: f.parentRunId, revisionId: first.revision.catalog.revision.revisionId, explanationCatalogId: first.explanationCatalog.explanationCatalogId });
    assert.equal(view.steps.length, 1); assert.equal(view.steps[0].kind, 'prepare-members');
    assert.equal((view.steps[0].input as any).phase, 'prepare-shape-explanation');
  });

  await t.test('same revision and configuration reuse the child across command keys and active users', async () => {
    const sameUserKey = randomUUID();
    const sameUser = await store.ensureExplanationForRevision({ actor: f.actor, parentRunId: f.parentRunId, revisionId: first.revision.catalog.revision.revisionId, idempotencyKey: sameUserKey, identity });
    assert.equal(sameUser.childRun.id, first.childRun.id); assert.equal(sameUser.created, false);
    const colleague = { organizationId: f.actor.organizationId, userId: randomUUID() };
    await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Colleague','member','active',now(),now())", [colleague.userId, colleague.organizationId, `${colleague.userId}@example.com`]);
    const colleagueKey = randomUUID();
    const reused = await store.ensureExplanationForRevision({ actor: colleague, parentRunId: f.parentRunId, revisionId: first.revision.catalog.revision.revisionId, idempotencyKey: colleagueKey, identity });
    assert.equal(reused.childRun.id, first.childRun.id); assert.equal(reused.created, false);
    const link = (await pg.pool.query('SELECT created_by FROM market_shape_explanation_runs WHERE child_run_id=$1', [first.childRun.id])).rows[0];
    assert.equal(link.created_by, f.actor.userId);
    const receipt = (await pg.pool.query("SELECT run_id,actor_id,receipt_json FROM market_analysis_commands WHERE organization_id=$1 AND kind='create' AND idempotency_key=$2", [f.actor.organizationId, colleagueKey])).rows[0];
    assert.equal(receipt.run_id, first.childRun.id); assert.equal(receipt.actor_id, colleague.userId); assert.equal(receipt.receipt_json.moduleRunId, first.childRun.id);
  });

  await t.test('a command key already bound to another explanation identity cannot reuse an existing child', async () => {
    const key = randomUUID(), revisionId = first.revision.catalog.revision.revisionId;
    await store.ensureExplanationForRevision({ actor: f.actor, parentRunId: f.parentRunId, revisionId, idempotencyKey: key, identity: { ...identity, configurationVersion: 'key-owner-config/v1' } });
    await assert.rejects(store.ensureExplanationForRevision({ actor: f.actor, parentRunId: f.parentRunId, revisionId, idempotencyKey: key, identity }));
  });

  await t.test('same configuration with a different prompt conflicts without leaving an orphan', async () => {
    const before = (await pg.pool.query('SELECT count(*) FROM market_analysis_module_runs')).rows[0].count;
    await assert.rejects(store.ensureExplanationForRevision({ actor: f.actor, parentRunId: f.parentRunId, revisionId: first.revision.catalog.revision.revisionId, idempotencyKey: randomUUID(), identity: { ...identity, promptVersion: 'shape-explanation-prompt/v2' } }));
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_module_runs')).rows[0].count, before);
  });

  await t.test('new revisions isolate children and a new configuration explicitly reanalyzes one revision', async () => {
    const second = await store.saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId, request: { ...f.request, expectedParentRevisionId: first.revision.catalog.revision.revisionId, note: 'second' }, idempotencyKey: randomUUID(), identity });
    assert.notEqual(second.childRun.id, first.childRun.id);
    const replay = await store.ensureExplanationForRevision({ actor: f.actor, parentRunId: f.parentRunId, revisionId: first.revision.catalog.revision.revisionId, idempotencyKey: randomUUID(), identity: { ...identity, configurationVersion: 'shape-explanation-config/v2' } });
    assert.notEqual(replay.childRun.id, first.childRun.id);
    assert.equal(replay.explanationCatalog.explanationCatalogId, first.explanationCatalog.explanationCatalogId);
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_shape_explanation_runs WHERE parent_run_id=$1', [f.parentRunId])).rows[0].count, '4');
  });

  await t.test('database rejects altered lineage and preserves parent suggestions', async () => {
    const before = await f.steps.findModuleRun({ actor: f.actor, moduleRunId: f.parentRunId });
    await assert.rejects(pg.pool.query('UPDATE market_shape_explanation_runs SET explanation_catalog_id=$1 WHERE child_run_id=$2', ['market-shape-explanation:' + 'a'.repeat(64), first.childRun.id]), /immutable/i);
    await assert.rejects(pg.pool.query('DELETE FROM market_shape_explanation_runs WHERE child_run_id=$1', [first.childRun.id]), /immutable/i);
    await assert.rejects(pg.pool.query(`INSERT INTO market_shape_explanation_runs(organization_id,study_id,parent_run_id,revision_id,explanation_catalog_id,configuration_version,child_run_id,created_by) SELECT organization_id,study_id,parent_run_id,$1,explanation_catalog_id,configuration_version,child_run_id,created_by FROM market_shape_explanation_runs LIMIT 1`, ['market-shape-revision:' + 'b'.repeat(64)]));
    const after = await f.steps.findModuleRun({ actor: f.actor, moduleRunId: f.parentRunId });
    assert.deepEqual(after, before);
  });

  await t.test('SQL constraints enforce lineage consistency while catalog authenticity remains a restored-store responsibility', async () => {
    const fakeCatalogId = 'market-shape-explanation:' + 'c'.repeat(64), revisionId = first.revision.catalog.revision.revisionId;
    const params = { flow: 'shape-explanation/v1' as const, parentRunId: f.parentRunId, revisionId, explanationCatalogId: fakeCatalogId };
    const forged = await f.steps.createModuleRun({ actor: f.actor, scope: f.scope, moduleKind: 'shape-price', params,
      versions: { source: 'market-shape-explanation-catalog/v1', rule: 'market-shape-explanation-catalog/v1', mapping: fakeCatalogId, planner: 'shape-explanation/v1', model: 'market.semantic.text.v1', prompt: 'forged-prompt/v1', configuration: 'forged-config/v1' },
      collectionRevision: revisionId, idempotencyKey: randomUUID(), initialSteps: marketShapeExplanationInitialSteps({ params }) });
    await pg.pool.query(`INSERT INTO market_shape_explanation_runs(organization_id,study_id,parent_run_id,revision_id,explanation_catalog_id,configuration_version,child_run_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [f.actor.organizationId, f.scope.researchId, f.parentRunId, revisionId, fakeCatalogId, 'forged-config/v1', forged.run.id, f.actor.userId]);
    assert.equal((await pg.pool.query('SELECT explanation_catalog_id FROM market_shape_explanation_runs WHERE child_run_id=$1', [forged.run.id])).rows[0].explanation_catalog_id, fakeCatalogId);
    // Public store methods never accept this value: they restore the immutable price catalog and derive its digest-bound explanation catalog.
    await assert.rejects(store.ensureExplanationForRevision({ actor: f.actor, parentRunId: f.parentRunId, revisionId, idempotencyKey: randomUUID(), identity: { configurationVersion: 'forged-config/v1', promptVersion: 'forged-prompt/v1' } }));
  });

  await t.test('foreign organizations, wrong parents and empty model identities cannot create work', async () => {
    const foreign = { organizationId: randomUUID(), userId: randomUUID() };
    await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Foreign','member','active',now(),now())", [foreign.userId, foreign.organizationId, `${foreign.userId}@example.com`]);
    await assert.rejects(store.ensureExplanationForRevision({ actor: foreign, parentRunId: f.parentRunId, revisionId: first.revision.catalog.revision.revisionId, idempotencyKey: randomUUID(), identity }));
    await assert.rejects(store.ensureExplanationForRevision({ actor: f.actor, parentRunId: randomUUID(), revisionId: first.revision.catalog.revision.revisionId, idempotencyKey: randomUUID(), identity }));
    await assert.rejects(store.ensureExplanationForRevision({ actor: f.actor, parentRunId: f.parentRunId, revisionId: first.revision.catalog.revision.revisionId, idempotencyKey: randomUUID(), identity: { configurationVersion: '', promptVersion: '' } }));
  });

  await t.test('a concurrent ensure holds the parent lock through child linkage before cancellation', async () => {
    await pg.pool.query("CREATE FUNCTION delay_shape_explanation_link() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$");
    await pg.pool.query('CREATE TRIGGER delay_shape_explanation_link BEFORE INSERT ON market_shape_explanation_runs FOR EACH ROW EXECUTE FUNCTION delay_shape_explanation_link()');
    const ensure = store.ensureExplanationForRevision({ actor: f.actor, parentRunId: f.parentRunId, revisionId: first.revision.catalog.revision.revisionId, idempotencyKey: randomUUID(), identity: { ...identity, configurationVersion: 'shape-explanation-config/v4' } });
    await new Promise(resolve => setTimeout(resolve, 30));
    const cancel = f.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.parentRunId, idempotencyKey: randomUUID() });
    const [ensured] = await Promise.all([ensure, cancel]);
    assert.ok(await f.steps.findModuleRun({ actor: f.actor, moduleRunId: ensured.childRun.id }));
    assert.equal((await f.steps.findModuleRun({ actor: f.actor, moduleRunId: f.parentRunId }))!.run.status, 'cancelled');
    await pg.pool.query('DROP TRIGGER delay_shape_explanation_link ON market_shape_explanation_runs');
    await pg.pool.query('DROP FUNCTION delay_shape_explanation_link()');
  });

  await t.test('a cancelled parent preserves revisions but refuses new child work', async () => {
    assert.ok(await f.revisions.find({ actor: f.actor, moduleRunId: f.parentRunId, revisionId: first.revision.catalog.revision.revisionId }));
    await assert.rejects(store.ensureExplanationForRevision({ actor: f.actor, parentRunId: f.parentRunId, revisionId: first.revision.catalog.revision.revisionId, idempotencyKey: randomUUID(), identity: { ...identity, configurationVersion: 'shape-explanation-config/v3' } }));
  });
});
