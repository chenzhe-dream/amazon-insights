import assert from 'node:assert/strict';
import test from 'node:test';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresMarketModelBudgetStore } from '../../server/db/postgres/market-model-budget-store';
import { createMarketSemanticSkillRunner } from '../../server/runtime/market-semantic-runner';
import { estimateMarketRequestInput, type MarketModelTransport } from '../../server/runtime/market-request-admission';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import { marketSemanticContracts, marketSemanticSchemaDefinitions } from '../../server/skills/market-semantic-task-definitions';
import { SkillRegistry } from '../../server/skills/registry';
import { validateMarketKeywordSemantics } from '../../server/domain/market-research/semantic-validation';
import type { MarketSemanticRecord } from '../../shared/market-semantic-contracts';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import { startPostgresTestContainer } from './helpers/postgres-test-container';

test('native factory uses the real OpenAI adapter, compact schema and shared persistent budget without duplicate schema prompts', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close());
  await runPostgresMigrations(pg.pool);
  const registry = await SkillRegistry.open('skills-src');
  const loaded = await registry.load('market-classify-keyword-demand', '1.0.0');
  for (const transport of ['responses-strict', 'relay-chat-json'] as MarketModelTransport[]) await t.test(transport, async () => {
    const f = await createMarketSemanticFixture(pg.pool, { manifest: loaded.manifest });
    const unknown = { status: 'unknown', reason: 'insufficient-evidence', evidence: [] };
    const value = { schemaVersion: '1.0.0', task: f.binding.task, batchId: f.inputProjection.batchId, inputDigest: f.inputProjection.inputDigest,
      keywords: [{ keywordId: 'keyword-a', W1: unknown, W2: unknown, W3: unknown, W4: unknown, cluster: unknown }], proposals: [], synonymRelations: [] };
    const sent: Record<string, any>[] = [];
    const invoke = async (body: Record<string, any>) => {
      sent.push(body);
      // Force one format repair. This is a transport/accounting fixture, not model quality evidence.
      const text = JSON.stringify(sent.length === 1 ? {} : value);
      return transport === 'responses-strict'
        ? { id: `synthetic-${sent.length}`, status: 'completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] }
        : { id: `synthetic-${sent.length}`, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] };
    };
    const client = { responses: { create: invoke }, chat: { completions: { create: invoke } } } as unknown as OpenAIProviderOptions['client'];
    const model = { name: 'synthetic-resolved-model', estimatedInputTokens: 10000, maxOutputTokens: 4000, timeoutMs: 90000,
      pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } };
    const cap = { maxTokens: 100000, maxCostMicros: 1000000 };
    const runner = createMarketSemanticSkillRunner(f.context, registry, { task: f.binding.task, model, providerName: 'synthetic-openai', transport,
      limits: { call: cap, run: cap, organizationUtcDay: cap }, openAI: { client } });
    const binding = { scope: f.scope, inputSnapshot: f.inputSnapshot, sourceEvidenceByRef: { [f.source.id]: f.source.evidence },
      selectionRevision: f.binding.selectionRevision, batchKey: f.binding.batchKey, inputDigest: f.binding.inputDigest, expectedIds: f.binding.memberRefs,
      sourceCatalog: Object.fromEntries(f.inputSnapshot.records.map(r => [r.id, (r.data as { semantic: MarketSemanticRecord }).semantic])) };
    const contracts = marketSemanticContracts['market-keyword-semantics'];
    const prepared = await runner.prepare({ skill: { id: loaded.manifest.id, version: loaded.manifest.version },
      inputContract: { name: loaded.manifest.inputSchema, schema: contracts.input, allowedFields: Object.keys(contracts.input.shape) },
      outputContract: { name: loaded.manifest.outputSchema, schema: contracts.output, schemaDefinitions: marketSemanticSchemaDefinitions[f.binding.task],
        canonicalizeOutput: candidate => validateMarketKeywordSemantics(f.inputProjection, candidate, binding) },
      input: f.inputProjection, snapshotIds: [f.binding.id], model });
    const result = await runner.runPrepared(prepared, f.subject, f.authority);
    assert.deepEqual(result.value, value); assert.equal(sent.length, 2);
    for (const body of sent) {
      assert.ok(Buffer.byteLength(JSON.stringify(body)) + 512 <= model.estimatedInputTokens);
      if (transport === 'relay-chat-json') { assert.equal(body.messages.length, 2); assert.equal(body.messages[0].role, 'system'); assert.equal(body.messages[1].role, 'user'); }
      const format = transport === 'responses-strict' ? body.text.format : body.response_format.json_schema;
      assert.deepEqual(format.schema, prepared.responseFormat.format.schema); assert.equal(format.strict, true);
      const reconstructed = { model: body.model, instructions: transport === 'responses-strict' ? body.instructions : body.messages[0].content,
        input: f.inputProjection, outputSchema: contracts.output, responseFormat: prepared.responseFormat, maxOutputTokens: 4000, timeoutMs: 90000 };
      assert.equal(estimateMarketRequestInput(reconstructed, transport), Buffer.byteLength(JSON.stringify(body)) + 512);
    }
    const ledger = await new PostgresMarketModelBudgetStore(f.context).getAgentUsage(f.authority);
    assert.equal(ledger.reservationCount, 2); assert.equal(ledger.usageCompleteness, 'complete');
    assert.equal(ledger.inputTokens, 200); assert.equal(ledger.outputTokens, 100);
    assert.deepEqual(ledger.attempts.map(a => a.kind), ['initial', 'format-repair']);
    const governed = (await pg.pool.query('SELECT organization_id,resource,job_id,attempt_kind FROM concurrency_physical_attempts WHERE job_id=$1 ORDER BY recorded_at,id', [f.subject.attemptId])).rows;
    assert.deepEqual(governed.map(r => r.attempt_kind), ['initial', 'repair']);
    assert.ok(governed.every(r => r.organization_id === f.actor.organizationId && r.resource === 'model'));
    assert.equal((await pg.pool.query('SELECT count(*)::int AS n FROM model_budget_reservations WHERE market_agent_run_id=$1 AND run_id IS NOT NULL', [f.record.id])).rows[0].n, 0);
  });
});
