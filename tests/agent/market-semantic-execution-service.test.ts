import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { MarketSemanticExecutionService } from '../../server/runtime/market-semantic-execution-service';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import { SkillRegistry } from '../../server/skills/registry';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import { startPostgresTestContainer } from './helpers/postgres-test-container';

test('market semantic service commits audited outputs and step receipts together and fences duplicate execution', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const registry = await SkillRegistry.open('skills-src');
  const manifest = (await registry.load('market-classify-keyword-demand', '1.0.0')).manifest;
  async function fixture() {
    const f = await createMarketSemanticFixture(pg.pool, { manifest });
    await f.stores.steps.settleAndEnqueue({ claim: f.modelClaim, outcome: { status: 'failed', error: { code: 'internal', retryable: false } } });
    await f.stores.steps.retryFailedSteps({ actor: f.actor, moduleRunId: f.subject.moduleRunId,
      steps: [{ stepId: f.modelClaim.stepId, failedAttemptId: f.modelClaim.attemptId }], idempotencyKey: randomUUID() });
    const claim = await f.stores.steps.claimStep({ moduleRunId: f.subject.moduleRunId, leaseOwnerId: randomUUID(), leaseMs: 30000 }); assert.ok(claim);
    const unknown = { status: 'unknown', reason: 'insufficient-evidence', evidence: [] };
    const value = { schemaVersion: '1.0.0', task: f.binding.task, batchId: f.inputProjection.batchId, inputDigest: f.inputProjection.inputDigest,
      keywords: [{ keywordId: 'keyword-a', W1: unknown, W2: unknown, W3: unknown, W4: unknown, cluster: unknown }], proposals: [], synonymRelations: [] };
    return { ...f, claim, value };
  }
  function setup(f: Awaited<ReturnType<typeof fixture>>, execute?: (body: unknown) => Promise<unknown>, options?: ConstructorParameters<typeof MarketSemanticExecutionService>[2]) {
    let calls = 0;
    const client = { responses: { create: async (body: unknown) => {
      calls++; const value = execute ? await execute(body) : f.value;
      return { id: 'synthetic-response', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] };
    } } } as unknown as OpenAIProviderOptions['client'];
    const cap = { maxTokens: 100000, maxCostMicros: 1000000 };
    const configuration = { task: 'market-keyword-semantics' as const, configurationVersion: 'fixture/v1',
      model: { name: 'gpt-5.6', estimatedInputTokens: 10000, maxOutputTokens: 4000, timeoutMs: 90000,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } }, providerName: 'synthetic-openai', transport: 'responses-strict' as const,
      limits: { call: cap, run: cap, organizationUtcDay: cap }, openAI: { client } };
    return { service: new MarketSemanticExecutionService(f.context, registry, options), configuration, calls: () => calls };
  }
  await t.test('successful binding is revalidated, persisted and replayed with no second model request', async () => {
    const f = await fixture(), s = setup(f);
    const result = await s.service.executeBatch(f.claim, s.configuration);
    assert.equal(result.status, 'succeeded'); assert.deepEqual(result.value, f.value); assert.equal(s.calls(), 1);
    const view = await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.claim.moduleRunId });
    assert.equal(view?.steps.find(x => x.id === f.claim.stepId)?.status, 'succeeded');
    const row = (await pg.pool.query('SELECT * FROM market_agent_runs WHERE attempt_id=$1', [f.claim.attemptId])).rows[0];
    assert.equal(row.validation_status, 'passed'); assert.equal(row.input_tokens, '100'); assert.equal(row.attempt_count, 1);
    assert.equal(result.agentRun.outcome?.inputTokens, 100);
    const replay = await s.service.executeBatch(f.claim, s.configuration);
    assert.equal(replay.status, 'succeeded'); assert.equal(replay.replayed, true); assert.equal(s.calls(), 1);
    await assert.rejects(() => s.service.executeBatch(f.claim, { ...s.configuration, configurationVersion: 'changed/v2' }));
  });
  await t.test('simultaneous invocation observes the active audit instead of dispatching another provider call', async () => {
    const f = await fixture(); let complete!: () => void, entered!: () => void;
    const started = new Promise<void>(r => { entered = r; }); const pending = new Promise<void>(r => { complete = r; });
    const s = setup(f, async () => { entered(); await pending; return f.value; });
    const first = s.service.executeBatch(f.claim, s.configuration); await started;
    try { assert.equal((await s.service.executeBatch(f.claim, s.configuration)).status, 'observing'); assert.equal(s.calls(), 1); }
    finally { complete(); }
    assert.equal((await first).status, 'succeeded');
  });
  await t.test('audit and step writes both roll back if step persistence fails, then recovery does not resend', async () => {
    const f = await fixture(), s = setup(f);
    await pg.pool.query(`CREATE FUNCTION reject_semantic_step() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.claim.attemptId}' AND NEW.status='succeeded' THEN RAISE EXCEPTION 'synthetic persistence failure'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_semantic_step BEFORE UPDATE ON market_analysis_step_attempts FOR EACH ROW EXECUTE FUNCTION reject_semantic_step()');
    try { await assert.rejects(() => s.service.executeBatch(f.claim, s.configuration)); }
    finally { await pg.pool.query('DROP TRIGGER reject_semantic_step ON market_analysis_step_attempts'); await pg.pool.query('DROP FUNCTION reject_semantic_step()'); }
    const row = (await pg.pool.query('SELECT * FROM market_agent_runs WHERE attempt_id=$1', [f.claim.attemptId])).rows[0];
    assert.equal(row.validation_status, 'pending'); assert.equal(s.calls(), 1);
    assert.equal((await pg.pool.query('SELECT status FROM market_analysis_step_attempts WHERE id=$1', [f.claim.attemptId])).rows[0].status, 'running');
    await pg.pool.query("UPDATE market_agent_runs SET execution_claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [row.id]);
    const recovered = await s.service.executeBatch(f.claim, s.configuration);
    assert.equal(recovered.status, 'failed'); assert.equal(s.calls(), 1);
    assert.equal((await pg.pool.query('SELECT input_tokens FROM market_agent_runs WHERE id=$1', [row.id])).rows[0].input_tokens, '100');
  });
  await t.test('heartbeat renews both the active step and audit claim while the provider is pending', async () => {
    const f = await fixture(), s = setup(f, async () => { await new Promise(r => setTimeout(r, 1300)); return f.value; }, { leaseMs: 600, heartbeatMs: 100 });
    await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE id=$1", [f.claim.stepId]);
    const result = await s.service.executeBatch(f.claim, s.configuration);
    assert.equal(result.status, 'succeeded'); assert.equal(s.calls(), 1);
    assert.ok(Date.parse(result.agentRun.claim.acquiredAt) > Date.parse(result.agentRun.startedAt) + 500);
  });
  await t.test('run cancellation fences a provider that ignores abort, and late completion cannot publish', async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const pending = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
    const s = setup(f, async () => { entered(); await pending; return f.value; }, { leaseMs: 1000, heartbeatMs: 100 });
    const execution = s.service.executeBatch(f.claim, s.configuration); await started;
    try {
      await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.claim.moduleRunId, idempotencyKey: randomUUID() });
      const cancelled=await execution;
      assert.equal(cancelled.agentRun.terminalStatus,'cancelled');assert.equal(cancelled.value,null);
    } finally { release(); }
    await new Promise(r => setImmediate(r));
    const view = await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.claim.moduleRunId });
    assert.equal(view?.run.status, 'cancelled'); assert.equal(view?.steps.find(s => s.id === f.claim.stepId)?.status, 'cancelled');
    const row = (await pg.pool.query('SELECT validation_status,output_json FROM market_agent_runs WHERE attempt_id=$1', [f.claim.attemptId])).rows[0];
    assert.equal(row.validation_status, 'failed'); assert.equal(row.output_json, null); assert.equal(s.calls(), 1);
    // Losing the execution lease must not discard provider-reported charges.
    let settled = false;
    for (let i = 0; i < 40; i++) {
      const rows = (await pg.pool.query('SELECT state,actual_input_tokens FROM model_budget_reservations WHERE market_attempt_id=$1', [f.claim.attemptId])).rows;
      if (rows.length === 1 && rows[0].state === 'settled') { assert.equal(rows[0].actual_input_tokens, '100'); settled = true; break; }
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(settled, true);
    const after = (await pg.pool.query('SELECT validation_status,output_json FROM market_agent_runs WHERE attempt_id=$1', [f.claim.attemptId])).rows[0];
    assert.deepEqual(after, row);
  });
  await t.test('synchronous provider work cannot publish after the fixed batch deadline', async () => {
    const f = await fixture(), s = setup(f, async () => {
      const until = performance.now() + 1200; while (performance.now() < until) { /* synthetic synchronous provider stall */ }
      return f.value;
    }, { batchTimeoutMs: 1000 });
    const result = await s.service.executeBatch(f.claim, s.configuration);
    assert.equal(result.status, 'failed'); assert.equal(result.agentRun.outcome?.error?.code, 'UPSTREAM_TEMPORARY'); assert.equal(s.calls(), 1);
    const view = await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.claim.moduleRunId });
    assert.equal(view?.attempts.find(a => a.id === f.claim.attemptId)?.output, null);
    assert.equal(await f.stores.steps.claimStep({ moduleRunId: f.claim.moduleRunId, leaseOwnerId: randomUUID(), leaseMs: 30000 }), null);
  });
  await t.test('deadline crossed during persistence rolls back success and atomically records failure', async () => {
    const f = await fixture(), s = setup(f, undefined, { batchTimeoutMs: 1400 });
    await pg.pool.query(`CREATE FUNCTION delay_semantic_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.claim.attemptId}' AND NEW.status='succeeded' THEN PERFORM pg_sleep(1.6); END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER delay_semantic_commit BEFORE UPDATE ON market_analysis_step_attempts FOR EACH ROW EXECUTE FUNCTION delay_semantic_commit()');
    try {
      const result = await s.service.executeBatch(f.claim, s.configuration);
      assert.equal(result.status, 'failed'); assert.equal(result.agentRun.outcome?.error?.code, 'UPSTREAM_TEMPORARY');
      assert.equal(result.agentRun.outcome?.inputTokens, 100); assert.equal(s.calls(), 1);
      const row = (await pg.pool.query('SELECT status,output_json FROM market_analysis_step_attempts WHERE id=$1', [f.claim.attemptId])).rows[0];
      assert.equal(row.status, 'failed'); assert.equal(row.output_json, null);
    } finally { await pg.pool.query('DROP TRIGGER delay_semantic_commit ON market_analysis_step_attempts'); await pg.pool.query('DROP FUNCTION delay_semantic_commit()'); }
  });
  await t.test('wrong saved batch identity and disabled actor reject before a physical model request', async () => {
    const f = await fixture(), s = setup(f);
    await assert.rejects(() => s.service.executeBatch({ ...f.claim, studyId: randomUUID() }, s.configuration));
    await assert.rejects(() => s.service.executeBatch({ ...f.claim, step: { ...f.claim.step, input: { task: f.binding.task, bindingId: f.binding.id, inputDigest: '0'.repeat(64) } } }, s.configuration));
    await pg.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [f.actor.userId]);
    await assert.rejects(() => s.service.executeBatch(f.claim, s.configuration));
    assert.equal(s.calls(), 0);
  });
  await t.test('manual retry cannot reset the semantic stage deadline stored by the first preparation attempt', async () => {
    const f = await fixture(), s = setup(f, undefined, { stageTimeoutMs: 100, batchTimeoutMs: 5000 });
    await new Promise(r => setTimeout(r, 150));
    const first = await s.service.executeBatch(f.claim, s.configuration);
    assert.equal(first.status, 'failed'); assert.match(first.agentRun.outcome?.error?.message ?? '', /stage deadline/); assert.equal(s.calls(), 0);
    await f.stores.steps.retryFailedSteps({ actor: f.actor, moduleRunId: f.claim.moduleRunId,
      steps: [{ stepId: f.claim.stepId, failedAttemptId: f.claim.attemptId }], idempotencyKey: randomUUID() });
    const next = await f.stores.steps.claimStep({ moduleRunId: f.claim.moduleRunId, leaseOwnerId: randomUUID(), leaseMs: 30000 }); assert.ok(next);
    const retried = await s.service.executeBatch(next, s.configuration);
    assert.equal(retried.status, 'failed'); assert.equal(s.calls(), 0);
    const row = (await pg.pool.query('SELECT error_json FROM market_analysis_step_attempts WHERE id=$1', [next.attemptId])).rows[0];
    assert.deepEqual(row.error_json, { code: 'timeout', retryable: false });
  });
});
