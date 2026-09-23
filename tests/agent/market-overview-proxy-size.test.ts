import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentServiceClient } from '../../app/lib/agent-service-client';
import { proxyAgentRequest } from '../../app/api/agent/[...path]/route';
import { MarketRuleBaselineSchema } from '../../shared/market-rule-baseline-contracts';
import { overviewRun, overviewDetails, overviewRunId, overviewStudyId } from './helpers/market-overview-page-fixture';

const mib = 1_048_576;
const runPath = `v1/market-analysis/runs/${overviewRunId}/overview`;
const env = { AGENT_SERVICE_INTERNAL_URL: 'http://agent.test', AGENT_SERVICE_PROXY_TOKEN: 'test-token' };

function largeReports() {
  const run = overviewRun();
  const entry = run.run.currentReport!;
  const evidence = { id: 'market-source:' + 'a'.repeat(64), scope: entry.report.scope };
  entry.report.ruleBaseline = MarketRuleBaselineSchema.parse({
    module: 'overview', ruleVersion: 'test/v1', scope: entry.report.scope, status: 'complete',
    metrics: Array.from({ length: 3200 }, (_, i) => ({
      key: `dimension-${i}/sample-products`, value: i, unit: 'count', denominator: null,
      status: 'complete', missingReason: null, evidenceRefs: [evidence],
    })), facts: [], missing: [], evidenceRefs: [evidence],
  });
  run.run.latestSavedReport = entry;
  run.run.history = [entry];
  const details = overviewDetails();
  details.entry = entry;
  for (const data of [run, details]) {
    assert.ok(Buffer.byteLength(JSON.stringify(data)) > mib);
    assert.ok(Buffer.byteLength(JSON.stringify(data)) < 8 * mib);
  }
  return { run, details };
}

async function proxy(path: string, fetchImplementation: typeof fetch, options: { method?: string; maxResponseBytes?: number } = {}) {
  const method = options.method ?? 'GET';
  return proxyAgentRequest(new Request(`http://web.test/api/agent/${path}`, {
    method, ...(method === 'POST' ? { body: JSON.stringify({ headTopN: 10, newProductMonths: 6 }),
      headers: { 'content-type': 'application/json', 'idempotency-key': overviewStudyId } } : {}),
  }), { params: Promise.resolve({ path: path.split('/') }) }, createAgentServiceClient({ env, fetchImplementation,
    ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
  }));
}

test('large overview status, saved details and idempotent start pass intact through the production proxy', async () => {
  const { run, details } = largeReports();
  for (const [path, method, payload] of [
    [runPath, 'GET', run],
    [`v1/market-analysis/runs/${overviewRunId}/reports/${details.entry.attemptId}/overview`, 'GET', details],
    [`v1/market-analysis/studies/${overviewStudyId}/overview`, 'POST', run],
  ] as const) {
    const response = await proxy(path, async () => Response.json(payload), { method });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), payload);
  }
});

test('overview budget remains bounded for declared and streamed UTF-8 response bytes', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const response = await proxy(runPath, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('数'.repeat(3 * mib))); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': String(9 * mib) } : {}) } }));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'AGENT_SERVICE_RESPONSE_TOO_LARGE');
    assert.equal(cancelled, true);
  }
});

test('other routes keep their 1 MiB bound and explicit client limits still apply to overview', async () => {
  for (const [path, maxResponseBytes] of [['v1/capabilities', undefined], [runPath, 64]] as const) {
    const response = await proxy(path, async () => Response.json({ data: 'x'.repeat(mib + 1) }), { maxResponseBytes });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'AGENT_SERVICE_RESPONSE_TOO_LARGE');
  }
});

test('larger overview budget still validates the response contract', async () => {
  const response = await proxy(runPath, async () => Response.json({ data: 'x'.repeat(mib + 1) }));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'AGENT_SERVICE_INVALID_RESPONSE');
});
