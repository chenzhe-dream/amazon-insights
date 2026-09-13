import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { loadVocPositioningRuntimeConfig } from '../../server/config';
import { createAgentService } from '../../server/agent-service';
import { PostgresAgentRepository } from '../../server/db/postgres-repository';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresQueryContext } from '../../server/db/postgres/query-context';
import { MarketModelBatchWorker, type MarketModelWorkerEvent } from '../../server/runtime/market-model-batch-worker';
import { createMarketModelRuntime } from '../../server/runtime/market-model-runtime';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import { SkillRegistry } from '../../server/skills/registry';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import { startPostgresTestContainer } from './helpers/postgres-test-container';

const syntheticMarketEnvironment = {
  OPENAI_API_KEY: 'synthetic-market-key', AGENT_VOC_MODEL: 'synthetic-market-model',
  AGENT_VOC_ESTIMATED_INPUT_TOKENS: '10000', AGENT_VOC_MAX_OUTPUT_TOKENS: '4000', AGENT_VOC_TIMEOUT_MS: '90000',
  AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: '1', AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: '2',
  AGENT_VOC_CALL_MAX_TOKENS: '100000', AGENT_VOC_CALL_MAX_COST_MICROS: '1000000',
  AGENT_VOC_RUN_MAX_TOKENS: '100000', AGENT_VOC_RUN_MAX_COST_MICROS: '1000000',
  AGENT_VOC_DAILY_MAX_TOKENS: '100000', AGENT_VOC_DAILY_MAX_COST_MICROS: '1000000', AGENT_VOC_WORKER_OWNER_ID: 'synthetic-worker',
};
const base = loadVocPositioningRuntimeConfig(syntheticMarketEnvironment);
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function syntheticReply(body: unknown) {
  const input = JSON.parse((body as { input: string }).input);
  const unknown = { status: 'unknown', reason: 'insufficient-evidence', evidence: [] };
  const value = { schemaVersion: '1.0.0', task: input.task, batchId: input.batchId, inputDigest: input.inputDigest,
    keywords: input.keywords.map((k: { keywordId: string }) => ({ keywordId: k.keywordId, W1: unknown, W2: unknown, W3: unknown, W4: unknown, cluster: unknown })),
    proposals: [], synonymRelations: [] };
  return { id: 'synthetic-response', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] };
}
function client(handler: (body: unknown) => Promise<unknown>): OpenAIProviderOptions['client'] {
  return { responses: { create: handler } } as unknown as OpenAIProviderOptions['client'];
}

test('market model queue lifecycle with isolated PostgreSQL and synthetic provider', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const context = new PostgresQueryContext(pg.pool);
  const manifest = (await (await SkillRegistry.open('skills-src')).load('market-classify-keyword-demand', '1.0.0')).manifest;
  async function queued(configurationVersion: string) {
    const f = await createMarketSemanticFixture(pg.pool, { manifest, configurationVersion });
    await f.stores.steps.settleAndEnqueue({ claim: f.modelClaim, outcome: { status: 'failed', error: { code: 'internal', retryable: false } } });
    await f.stores.steps.retryFailedSteps({ actor: f.actor, moduleRunId: f.subject.moduleRunId,
      steps: [{ stepId: f.modelClaim.stepId, failedAttemptId: f.modelClaim.attemptId }], idempotencyKey: randomUUID() });
    return f;
  }
  async function status(f: Awaited<ReturnType<typeof queued>>) {
    return (await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId }))!.steps.find(s => s.id === f.modelClaim.stepId)!.status;
  }
  await t.test('two consumers and repeated ticks dispatch exactly once; restart does not repeat completed work', async () => {
    const entered = deferred(), release = deferred(); let calls = 0;
    const sdk = client(async body => { calls++; entered.resolve(); await release.promise; return syntheticReply(body); });
    const first = await createMarketModelRuntime(context, base, { client: sdk });
    const second = await createMarketModelRuntime(context, base, { client: sdk });
    const f = await queued(first.configurationVersion);
    const running = first.tick(); assert.equal(first.tick(), running); await entered.promise;
    try { assert.equal(await second.tick(), false); assert.equal(calls, 1); }
    finally { release.resolve(); }
    assert.equal(await running, true); assert.equal(await status(f), 'succeeded');
    await first.stop(); await second.stop();
    const restarted = await createMarketModelRuntime(context, base, { client: sdk });
    try { assert.equal(await restarted.tick(), false); assert.equal(calls, 1); }
    finally { await restarted.stop(); }
    const rows = (await pg.pool.query('SELECT validation_status FROM market_agent_runs WHERE module_run_id=$1 AND attempt_id<>$2', [f.subject.moduleRunId, f.modelClaim.attemptId])).rows;
    assert.deepEqual(rows.map(r => r.validation_status), ['passed']);
  });
  await t.test('configuration lineage failure ends preparation without model dispatch or raw error logging', async () => {
    let calls = 0; const events: MarketModelWorkerEvent[] = [];
    const runtime = await createMarketModelRuntime(context, base, { client: client(async body => { calls++; return syntheticReply(body); }), worker: { onEvent: e => events.push(e) } });
    const f = await queued('wrong-configuration-secret');
    try { assert.equal(await runtime.tick(), true); assert.equal(await status(f), 'failed'); assert.equal(calls, 0); }
    finally { await runtime.stop(); }
    assert.equal(events.at(-1)?.event, 'preparation-failed'); assert.doesNotMatch(JSON.stringify(events), /secret|synthetic-market-key/);
    assert.equal((await f.stores.audit.listAgentRuns({ actor: f.actor, studyId: f.scope.researchId, moduleRunId: f.subject.moduleRunId })).length, 1);
  });
  await t.test('stop interrupts pending configuration; lease is renewed while preparing', async () => {
    const f = await queued('fixture/v1'); const entered = deferred(), pending = deferred<never>(); let calls = 0;
    const worker = new MarketModelBatchWorker({ steps: f.stores.steps, audit: f.stores.audit, leaseMs: 600, heartbeatMs: 100,
      execution: { executeBatch: async () => { calls++; throw new Error('must not execute'); } },
      resolveConfiguration: () => { entered.resolve(); return pending.promise; } });
    const running = worker.tick(); await entered.promise;
    await new Promise(r => setTimeout(r, 800));
    assert.equal(await status(f), 'running');
    assert.equal(await f.stores.steps.claimStep({ moduleRunId: f.subject.moduleRunId, leaseOwnerId: randomUUID(), leaseMs: 1000 }), null);
    await worker.stop(); await running; assert.equal(await status(f), 'failed'); assert.equal(calls, 0);
    assert.equal(await worker.tick(), false); assert.throws(() => worker.start(), /cannot be restarted/);
    const view = await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId });
    assert.deepEqual(view!.attempts.at(-1)?.error, { code: 'interrupted', retryable: false });
  });
  await t.test('stop during provider work persists failure; late reply only settles charges', async () => {
    const entered = deferred(), release = deferred(); let calls = 0;
    const runtime = await createMarketModelRuntime(context, base, { client: client(async body => { calls++; entered.resolve(); await release.promise; return syntheticReply(body); }) });
    const f = await queued(runtime.configurationVersion); const running = runtime.tick(); await entered.promise;
    try { await runtime.stop(); await running; assert.equal(await status(f), 'failed'); }
    finally { release.resolve(); }
    let settled = false;
    for (let i = 0; i < 60; i++) {
      const rows = (await pg.pool.query('SELECT state,actual_input_tokens FROM model_budget_reservations WHERE market_module_run_id=$1', [f.subject.moduleRunId])).rows;
      if (rows.length === 1 && rows[0].state === 'settled') { assert.equal(rows[0].actual_input_tokens, '100'); settled = true; break; }
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(settled, true); assert.equal(await status(f), 'failed'); assert.equal(calls, 1);
    assert.equal(await runtime.tick(), false);
    const rows = (await pg.pool.query('SELECT output_json FROM market_agent_runs WHERE module_run_id=$1', [f.subject.moduleRunId])).rows;
    assert.ok(rows.every(r => r.output_json === null));
  });
  await t.test('polling start is idempotent and stop prevents subsequent claims', async () => {
    let calls = 0; const complete = deferred();
    const runtime = await createMarketModelRuntime(context, base, { client: client(async body => { calls++; return syntheticReply(body); }),
      worker: { pollMs: 25, onEvent: e => { if (e.event === 'succeeded') complete.resolve(); } } });
    const f = await queued(runtime.configurationVersion); runtime.start(); runtime.start();
    await complete.promise; await runtime.stop(); assert.equal(await status(f), 'succeeded');
    const next = await queued(runtime.configurationVersion);
    assert.equal(await runtime.tick(), false); assert.equal(await status(next), 'queued'); assert.equal(calls, 1);
    await next.stores.steps.cancelModuleRun({ actor: next.actor, moduleRunId: next.subject.moduleRunId, idempotencyKey: randomUUID() });
  });
  await t.test('configuration identity excludes credential rotation but includes endpoint, budget and model', async () => {
    const initial = await createMarketModelRuntime(context, base);
    for (const [changed, same] of [
      [{ ...base, apiKey: 'rotated-secret' }, true],
      [{ ...base, baseUrl: 'https://synthetic.invalid/v1' }, false],
      [{ ...base, model: { ...base.model, name: 'different-model' } }, false],
      [{ ...base, budgetLimits: { ...base.budgetLimits, call: { ...base.budgetLimits.call, maxTokens: 99000 } } }, false],
    ] as const) {
      const runtime = await createMarketModelRuntime(context, changed);
      assert.equal(runtime.configurationVersion === initial.configurationVersion, same);
      assert.doesNotMatch(JSON.stringify(runtime), /secret|apiKey|baseUrl/); await runtime.stop();
    }
    await initial.stop();
  });
  await t.test('runtime leaves other modules rules queued while only the customer-theme rules handler is registered', async () => {
    const runtime = await createMarketModelRuntime(context, base);
    const f = await queued(runtime.configurationVersion);
    await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId, idempotencyKey: randomUUID() });
    const previous = (await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId }))!.run;
    const rules = await f.stores.steps.createModuleRun({ actor: f.actor, scope: f.scope, moduleKind: 'keywords', params: {},
      versions: previous.versions, collectionRevision: randomUUID(), idempotencyKey: randomUUID(),
      initialSteps: [{ stepKey: 'rules/one', kind: 'rules', subject: {}, input: {}, inputRefs: [] }] });
    try { assert.equal(await runtime.tick(), false); }
    finally { await runtime.stop(); }
    const view = await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: rules.run.id });
    assert.equal(view!.steps[0]!.status, 'queued'); assert.equal(view!.attempts.length, 0);
    await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: rules.run.id, idempotencyKey: randomUUID() });
  });
  const configuration = { task: 'market-keyword-semantics' as const, configurationVersion: 'fixture/v1', model: base.model,
    providerName: base.providerName, transport: base.transport, limits: base.budgetLimits, openAI: {} };
  await t.test('stop during an in-flight claim records interrupted preparation without execution', async () => {
    const f = await queued('fixture/v1'), entered = deferred(), release = deferred(); let calls = 0;
    const steps = new Proxy(f.stores.steps, { get(target, key) {
      if (key === 'claimStep') return async (input: Parameters<typeof target.claimStep>[0]) => {
        const claim = await target.claimStep(input); entered.resolve(); await release.promise; return claim;
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const worker = new MarketModelBatchWorker({ steps, audit: f.stores.audit, resolveConfiguration: () => configuration,
      execution: { executeBatch: async () => { calls++; throw new Error('unexpected dispatch'); } } });
    const running = worker.tick(); await entered.promise; const stopping = worker.stop(); release.resolve();
    await stopping; await running; assert.equal(calls, 0); assert.equal(await status(f), 'failed');
  });
  await t.test('bounded stop keeps the actual in-flight handle and cannot dispatch another batch', async () => {
    const f = await queued('fixture/v1'), entered = deferred(), release = deferred(); let calls = 0;
    const worker = new MarketModelBatchWorker({ steps: f.stores.steps, audit: f.stores.audit, stopTimeoutMs: 100,
      resolveConfiguration: () => configuration,
      execution: { executeBatch: async () => { calls++; entered.resolve(); await release.promise; throw new Error('synthetic stalled execution'); } } });
    const running = worker.tick(); await entered.promise;
    try {
      await assert.rejects(worker.stop(), /stop deadline/); assert.equal(worker.tick(), running);
      assert.throws(() => worker.start(), /cannot be restarted/); assert.equal(calls, 1);
    } finally { release.resolve(); await running; }
    assert.equal(await worker.tick(), false); assert.equal(await status(f), 'failed');
  });
  await t.test('exception after audit creation preserves forensic history and never performs an outer model retry', async () => {
    const f = await queued('fixture/v1'); let calls = 0; const events: MarketModelWorkerEvent[] = [];
    const worker = new MarketModelBatchWorker({ steps: f.stores.steps, audit: f.stores.audit, resolveConfiguration: () => configuration,
      onEvent: e => events.push(e), execution: { executeBatch: async claim => {
        calls++; await f.stores.audit.beginAgentRun({ ...f.beginInput, id: randomUUID(), claimToken: randomUUID(), subject: {
          ...f.subject, stepId: claim.stepId, attemptId: claim.attemptId, leaseOwnerId: claim.leaseOwnerId, leaseGeneration: claim.leaseGeneration,
        } }); throw new Error('sensitive synthetic persistence failure');
      } } });
    assert.equal(await worker.tick(), true); assert.equal(await status(f), 'running');
    assert.equal(events.at(-1)?.event, 'persistence-failed'); assert.doesNotMatch(JSON.stringify(events), /sensitive/);
    await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.modelClaim.stepId]);
    assert.equal(await worker.tick(), false); assert.equal(await status(f), 'failed'); assert.equal(calls, 1);
    await worker.stop();
    const records = await f.stores.audit.listAgentRuns({ actor: f.actor, studyId: f.scope.researchId, moduleRunId: f.subject.moduleRunId });
    assert.equal(records.length, 2); assert.ok(records.every(r => r.outcome === null));
  });
  await t.test('real Agent Service start consumes native queue and stop leaves subsequent work untouched', async () => {
    let calls = 0;
    const sdk = client(async body => { calls++; return syntheticReply(body); });
    const configurationOnly = await createMarketModelRuntime(context, base, { client: sdk });
    const f = await queued(configurationOnly.configurationVersion); await configurationOnly.stop();
    const service = await createAgentService({ repository: new PostgresAgentRepository(pg.pool), logger: false, marketModelClient: sdk,
      env: { ...syntheticMarketEnvironment, AGENT_VOC_LOCAL_FAKE: '1', AGENT_SERVICE_PROXY_TOKEN: 'synthetic-service-token',
        AGENT_SERVICE_TRUSTED_ORIGINS: 'http://127.0.0.1:3001', AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: '1' } });
    try {
      await service.start({ host: '127.0.0.1', port: 0 });
      const deadline = Date.now() + 15000;
      while (await status(f) !== 'succeeded' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      assert.equal(await status(f), 'succeeded'); assert.equal(calls, 1);
    } finally { await service.stop(); }
    const next = await queued(configurationOnly.configurationVersion);
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(await status(next), 'queued'); assert.equal(calls, 1);
    await next.stores.steps.cancelModuleRun({ actor: next.actor, moduleRunId: next.subject.moduleRunId, idempotencyKey: randomUUID() });
  });
  await t.test('polling automatically prepares queued input then analyzes it in the same single runtime slot', async () => {
    let calls = 0; const complete = deferred(); const phases: string[] = [];
    const runtime = await createMarketModelRuntime(context, base, { client: client(async body => { calls++; phases.push('provider'); return syntheticReply(body); }),
      worker: { pollMs: 25, onEvent: e => { if (e.event === 'succeeded') { phases.push('model-saved'); complete.resolve(); } } },
      stepWorker: { onEvent: e => { if (e.event === 'succeeded') phases.push('prepared'); } } });
    const f = await queued(runtime.configurationVersion);
    await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId, idempotencyKey: randomUUID() });
    const previous = (await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId }))!.run;
    const created = await f.stores.steps.createModuleRun({ actor: f.actor, scope: f.scope, moduleKind: 'keywords', params: {}, versions: previous.versions,
      collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: [{ stepKey: 'prepare/real-input', kind: 'prepare-model-batches', subject: { task: 'market-keyword-semantics' },
        input: { task: 'market-keyword-semantics', inputSnapshotId: f.inputSnapshot.snapshotId, selectionRevision: 'selection/v1', dataCutoffAt: f.inputProjection.dataCutoffAt },
        inputRefs: [{ kind: 'input', id: f.inputSnapshot.snapshotId }] }] });
    try { runtime.start(); await complete.promise; }
    finally { await runtime.stop(); }
    assert.equal(calls, 1); assert.deepEqual(phases, ['prepared', 'provider', 'model-saved']);
    const view = (await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: created.run.id }))!;
    assert.deepEqual(view.steps.map(s => s.status), ['succeeded', 'succeeded']);
    assert.notEqual(view.run.status, 'succeeded'); // No report has been published.
    assert.equal(await runtime.tick(), false);
  });
});
