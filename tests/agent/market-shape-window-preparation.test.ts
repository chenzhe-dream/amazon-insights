import type {MarketStepDefinition} from '../../server/db/market-module-execution-repository';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresMarketAnalysisSnapshotStore } from '../../server/db/postgres/market-analysis-snapshot-store';
import { PostgresMarketShapeExplanationRunStore } from '../../server/db/postgres/market-shape-explanation-run-store';
import { decodeMarketShapeExplanationWindows } from '../../server/domain/market-research/shape-explanation-wire';
import { createMarketShapeExplanationWindowStep } from '../../server/runtime/market-shape-explanation-window-step';
import { SkillRegistry } from '../../server/skills/registry';
import { loadMarketShapeExplanationCatalog } from '../../server/services/market-shape-explanation-input-service';
import { createMarketShapeExplanationRunFixture } from './helpers/market-shape-explanation-run-fixture';
import { startPostgresTestContainer } from './helpers/postgres-test-container';

const task = 'market-shape-structure-explanation' as const;
const cap = { maxTokens: 100_000, maxCostMicros: 1_000_000 };

function configuration(configurationVersion: string) {
  return {
    task,
    configurationVersion,
    providerName: 'must-not-run-provider',
    transport: 'responses-strict' as const,
    model: {
      name: 'shape-window-fixture',
      estimatedInputTokens: 12_000,
      maxOutputTokens: 4_000,
      timeoutMs: 60_000,
      pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
    },
    limits: { call: cap, run: cap, organizationUtcDay: cap },
    openAI: {
      apiKey: 'unused',
      client: { responses: { create: async () => { throw new Error('window preparation must not call the provider'); } } },
    },
  } as any;
}

async function rowCounts(pool: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }, runId: string) {
  const result = await pool.query(`SELECT
    (SELECT count(*)::int FROM market_analysis_inputs WHERE study_id=r.study_id) AS inputs,
    (SELECT count(*)::int FROM market_analysis_steps WHERE run_id=r.id) AS steps,
    (SELECT count(*)::int FROM market_agent_runs WHERE module_run_id=r.id) AS agent_runs,
    (SELECT count(*)::int FROM model_budget_reservations WHERE market_module_run_id=r.id) AS reservations
    FROM market_analysis_module_runs r WHERE r.id=$1`, [runId]);
  return result.rows[0];
}

test('native shape window preparation freezes and persists a complete decodable manifest without model execution', { timeout: 120_000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const f = await createMarketShapeExplanationRunFixture(pg.pool), registry = await SkillRegistry.open('skills-src');
  const configurationVersion = 'shape-window-preparation/v1', promptVersion = 'shape-window-prompt/v1';
  const linked = await new PostgresMarketShapeExplanationRunStore(f.context).saveRevisionAndEnsureExplanation({
    actor: f.actor, parentRunId: f.parentRunId, request: f.request, idempotencyKey: randomUUID(), identity: { configurationVersion, promptVersion },
  });
  const catalog = await loadMarketShapeExplanationCatalog(f.context, f.actor, linked.childRun.id);
  const claim = await f.steps.claimStep({ moduleRunId: linked.childRun.id, kinds: ['prepare-members'], leaseOwnerId: randomUUID(), leaseMs: 120_000 });
  assert.ok(claim); assert.equal((claim.step.input as any).phase, 'prepare-shape-explanation');
  const handler = createMarketShapeExplanationWindowStep(f.context, { registry, configuration: configuration(configurationVersion) });
  const before = await rowCounts(pg.pool, linked.childRun.id);
  const first = await handler({ claim, signal: new AbortController().signal });
  const second = await handler({ claim, signal: new AbortController().signal });
  assert.deepEqual(second, first, 'repeated computation must be deterministic');
  assert.deepEqual(await rowCounts(pg.pool, linked.childRun.id), before, 'the handler must not write before native settlement');
  assert.equal(first.kind, 'settlement');
  const manifest = first.value.outcome.status === 'succeeded' ? first.value.outcome.output as any : null;
  assert.ok(manifest); assert.equal(manifest.manifestVersion, 'shape-explanation-windows/v2');
  assert.equal(manifest.explanationCatalogId, catalog.explanationCatalogId); assert.equal(manifest.revisionId, catalog.revisionId);
  assert.ok(Array.isArray(manifest.windows)); assert.ok(manifest.windows.length >= 6);
  assert.deepEqual(decodeMarketShapeExplanationWindows(catalog, manifest.windows), { rows: catalog.rows, limitations: catalog.limitations });
  assert.equal(first.value.inputs?.length, manifest.windows.length); assert.equal(first.value.children?.length, manifest.windows.length);
  for (let index = 0; index < manifest.windows.length; index++) {
    const window = manifest.windows[index], input = first.value.inputs![index] as any;
    const child:MarketStepDefinition = first.value.children![index];
    assert.equal(input.kind, 'overview'); assert.deepEqual(input.expectedRecordIds, [window.windowId]); assert.equal(input.records.length, 1);
    assert.equal(input.records[0].id, window.windowId); assert.deepEqual(input.records[0].data.semantic.window, window);
    assert.equal(input.records[0].data.semantic.task, task); assert.equal(child.kind, 'prepare-model-batches');
    assert.equal((child.input as any).task, task); assert.equal((child.input as any).selectionRevision, catalog.revisionId);
  }
  const receipt = await f.steps.settleAndEnqueue({ claim, ...first.value });
  assert.equal(receipt.status, 'committed'); assert.equal(receipt.inputIds.length, manifest.windows.length); assert.equal(receipt.childStepIds.length, manifest.windows.length);
  const snapshots = new PostgresMarketAnalysisSnapshotStore(f.context);
  for (let index = 0; index < receipt.inputIds.length; index++) {
    const saved = await snapshots.findInput({ actor: f.actor, studyId: f.scope.researchId, id: receipt.inputIds[index] }); assert.ok(saved);
    assert.deepEqual(saved.snapshot.expectedRecordIds, [manifest.windows[index].windowId]);
  }
  assert.equal((await f.steps.settleAndEnqueue({ claim, ...first.value })).status, 'already-committed');
  const view = (await f.steps.findModuleRun({ actor: f.actor, moduleRunId: linked.childRun.id }))!;
  assert.equal(view.steps.filter(step => step.kind === 'prepare-model-batches').length, manifest.windows.length);
  assert.equal(view.steps.some(step => step.kind === 'model-batch' || step.kind === 'report'), false);
  assert.equal((await rowCounts(pg.pool, linked.childRun.id)).agent_runs, 0); assert.equal((await rowCounts(pg.pool, linked.childRun.id)).reservations, 0);
  const afterCommit = await rowCounts(pg.pool, linked.childRun.id);
  await assert.rejects(handler({ claim, signal: new AbortController().signal }));
  assert.deepEqual(await rowCounts(pg.pool, linked.childRun.id), afterCommit, 'a completed claim cannot run or write again');
});

test('aborted, cancelled, mismatched-configuration and forged claims cannot prepare or persist windows', { timeout: 120_000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const f = await createMarketShapeExplanationRunFixture(pg.pool), registry = await SkillRegistry.open('skills-src');
  const configurationVersion = 'shape-window-rejection/v1';
  const linked = await new PostgresMarketShapeExplanationRunStore(f.context).saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId,
    request: f.request, idempotencyKey: randomUUID(), identity: { configurationVersion, promptVersion: 'shape-window-rejection-prompt/v1' } });
  const claim = await f.steps.claimStep({ moduleRunId: linked.childRun.id, kinds: ['prepare-members'], leaseOwnerId: randomUUID(), leaseMs: 120_000 }); assert.ok(claim);
  const handler = createMarketShapeExplanationWindowStep(f.context, { registry, configuration: configuration(configurationVersion) });
  const before = await rowCounts(pg.pool, linked.childRun.id), aborted = new AbortController(); aborted.abort();
  await assert.rejects(handler({ claim, signal: aborted.signal }), error => (error as Error).name === 'AbortError');
  await assert.rejects(createMarketShapeExplanationWindowStep(f.context, { registry, configuration: configuration('wrong/v1') })({ claim, signal: new AbortController().signal }));
  await assert.rejects(handler({ claim: { ...claim, inputHash: 'f'.repeat(64) }, signal: new AbortController().signal }));
  assert.deepEqual(await rowCounts(pg.pool, linked.childRun.id), before);
  await f.steps.cancelModuleRun({ actor: f.actor, moduleRunId: linked.childRun.id, idempotencyKey: randomUUID() });
  await assert.rejects(handler({ claim, signal: new AbortController().signal }));
  assert.deepEqual(await rowCounts(pg.pool, linked.childRun.id), before);
});
