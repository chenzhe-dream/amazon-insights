import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { MarketModuleStepWorker } from '../../server/runtime/market-module-step-worker';
import type { MarketStepSettlement } from '../../server/db/market-module-execution-repository';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import { startPostgresTestContainer } from './helpers/postgres-test-container';

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const success: Omit<MarketStepSettlement, 'claim'> = { outcome: { status: 'succeeded', output: { synthetic: true } } };
test('general market step worker fences preparation and atomic commit', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  async function fixture() {
    const f = await createMarketSemanticFixture(pg.pool);
    await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId, idempotencyKey: randomUUID() });
    const previous = (await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId }))!.run;
    const created = await f.stores.steps.createModuleRun({ actor: f.actor, scope: f.scope, moduleKind: 'keywords', params: {}, versions: previous.versions,
      collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: [{ stepKey: 'rules/one', kind: 'rules', subject: {}, input: {}, inputRefs: [] }] });
    const view = () => f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: created.run.id });
    return { ...f, runId: created.run.id, view };
  }
  await t.test('two workers and reentrant ticks compute once; committed results are not repeated', async () => {
    const f = await fixture(), entered = deferred(), release = deferred(); let calls = 0;
    const handlers = { rules: async () => { calls++; entered.resolve(); await release.promise; return { kind: 'settlement' as const, value: success }; } };
    const first = new MarketModuleStepWorker({ steps: f.stores.steps, handlers }), second = new MarketModuleStepWorker({ steps: f.stores.steps, handlers });
    const running = first.tick(); assert.equal(first.tick(), running); await entered.promise;
    try { assert.equal(await second.tick(), false); assert.equal(calls, 1); } finally { release.resolve(); }
    assert.equal(await running, true); assert.equal((await f.view())!.steps[0].status, 'succeeded');
    assert.equal(await first.tick(), false); assert.equal(calls, 1); await first.stop(); await second.stop();
  });
  await t.test('preparation heartbeats are drained before the atomic commit begins', async () => {
    const f = await fixture(); let renewals = 0;
    const steps = new Proxy(f.stores.steps, { get(target, key) {
      if (key === 'renewStep') return async (input: Parameters<typeof target.renewStep>[0]) => { renewals++; return target.renewStep(input); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const worker = new MarketModuleStepWorker({ steps, leaseMs: 900, heartbeatMs: 100, handlers: { rules: async ({ claim }) => {
      await new Promise(r => setTimeout(r, 1100)); assert.ok(renewals >= 5);
      return { kind: 'atomic', commit: async () => { const before = renewals; await new Promise(r => setTimeout(r, 1100));
        assert.equal(renewals, before); await f.stores.steps.settleAndEnqueue({ claim, ...success }); } };
    } } });
    await worker.tick(); await worker.stop(); assert.equal((await f.view())!.steps[0].status, 'succeeded');
  });
  await t.test('stop cancels a computation that ignores abort, and discards its late commit function', async () => {
    const f = await fixture(), entered = deferred(), release = deferred(); let commits = 0;
    const worker = new MarketModuleStepWorker({ steps: f.stores.steps, handlers: { rules: async () => {
      entered.resolve(); await release.promise; return { kind: 'atomic', commit: async () => { commits++; } };
    } } });
    const running = worker.tick(); await entered.promise; await worker.stop(); await running;
    release.resolve(); await new Promise(r => setImmediate(r));
    const view = (await f.view())!; assert.equal(commits, 0); assert.equal(view.attempts[0].status, 'failed');
    assert.deepEqual(view.attempts[0].error, { code: 'interrupted', retryable: true });
    assert.equal(await worker.tick(), false); assert.throws(() => worker.start(), /cannot be restarted/);
    await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.runId, idempotencyKey: randomUUID() });
  });
  await t.test('deadline fences a synchronous stall and never invokes its commit', async () => {
    const f = await fixture(); let commits = 0;
    const worker = new MarketModuleStepWorker({ steps: f.stores.steps, workTimeoutMs: 100, handlers: { rules: async () => {
      const end = performance.now() + 160; while (performance.now() < end) { /* synthetic CPU stall */ }
      return { kind: 'atomic', commit: async () => { commits++; } };
    } } });
    await worker.tick(); await worker.stop(); assert.equal(commits, 0);
    assert.deepEqual((await f.view())!.attempts[0].error, { code: 'timeout', retryable: true });
    await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.runId, idempotencyKey: randomUUID() });
  });
  await t.test('unregistered work is not claimed and model-batch handlers are rejected', async () => {
    const f = await fixture(); const worker = new MarketModuleStepWorker({ steps: f.stores.steps, handlers: { report: async () => ({ kind: 'settlement', value: success }) } });
    assert.equal(await worker.tick(), false); assert.equal((await f.view())!.attempts.length, 0); await worker.stop();
    assert.throws(() => new MarketModuleStepWorker({ steps: f.stores.steps, handlers: { 'model-batch': async () => ({ kind: 'settlement', value: success }) } as never }));
    await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.runId, idempotencyKey: randomUUID() });
  });
  await t.test('an atomic callback cannot claim success without a persisted terminal attempt', async () => {
    const f = await fixture(); const worker = new MarketModuleStepWorker({ steps: f.stores.steps, handlers: { rules: async () => ({ kind: 'atomic', commit: async () => {} }) } });
    await worker.tick(); await worker.stop(); const view = (await f.view())!;
    assert.equal(view.steps[0].status, 'failed'); assert.deepEqual(view.attempts[0].error, { code: 'internal', retryable: false });
  });
  await t.test('bounded shutdown retains an in-flight database commit handle instead of starting new work', async () => {
    const f = await fixture(), entered = deferred(), release = deferred(); let work = 0;
    const worker = new MarketModuleStepWorker({ steps: f.stores.steps, stopTimeoutMs: 100, handlers: { rules: async () => {
      work++; return { kind: 'atomic', commit: async () => { entered.resolve(); await release.promise; } };
    } } });
    const running = worker.tick(); await entered.promise;
    try { await assert.rejects(worker.stop(), /stop deadline/); assert.equal(worker.tick(), running); assert.equal(work, 1); }
    finally { release.resolve(); await running; }
    assert.equal(await worker.tick(), false);
    await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.runId, idempotencyKey: randomUUID() });
  });
  await t.test('run cancellation during work prevents commit and preserves cancelled state', async () => {
    const f = await fixture(), entered = deferred(), release = deferred(); let commits = 0;
    const worker = new MarketModuleStepWorker({ steps: f.stores.steps, leaseMs: 600, heartbeatMs: 100, handlers: { rules: async () => {
      entered.resolve(); await release.promise; return { kind: 'atomic', commit: async () => { commits++; } };
    } } });
    const running = worker.tick(); await entered.promise;
    await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.runId, idempotencyKey: randomUUID() });
    await running; release.resolve(); await worker.stop(); assert.equal(commits, 0);
    assert.equal((await f.view())!.steps[0].status, 'cancelled');
  });
});
