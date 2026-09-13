import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { registerMarketModuleRoutes } from '../../server/routes/market-modules';
import { MarketModuleService } from '../../server/services/market-module-service';
import { findHttpContract } from '../../shared/agent-contracts';
import { classifyRoute, type RequestPrincipal } from '../../server/auth/authorization';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import { MarketThemeRunResponseSchema } from '../../shared/market-module-contracts';
import { buildAgentApp } from '../../server/app';
import type { AuthenticationService } from '../../server/auth/authentication-service';
import { createAgentServiceClient } from '../../app/lib/agent-service-client';
import { proxyAgentRequest } from '../../app/api/agent/[...path]/route';
import { MarketModuleStepWorker } from '../../server/runtime/market-module-step-worker';
import { createMarketSourceStepHandlers } from '../../server/runtime/market-source-step-handlers';
import { createMarketSourceProjectionStep } from '../../server/runtime/market-source-projection-step';
import { createMarketThemeReportStep } from '../../server/runtime/market-theme-report-step';
import type { RemoteMcpConnector } from '../../server/connectors/connector-contract';

test('market module browser proxy contracts require sessions on all entry points', () => {
  const id = randomUUID();
  for (const [method, path] of [['POST', '/v1/market-analysis/studies'], ['GET', `/v1/market-analysis/studies/${id}`],
    ['POST', `/v1/market-analysis/studies/${id}/customer-themes`], ['GET', `/v1/market-analysis/runs/${id}`],
    ['POST', `/v1/market-analysis/studies/${id}/overview`],['GET', `/v1/market-analysis/runs/${id}/overview`],['GET', `/v1/market-analysis/runs/${id}/reports/${id}/overview`],
    ['POST', `/v1/market-analysis/runs/${id}/retry`], ['POST', `/v1/market-analysis/runs/${id}/cancel`], ['GET', `/v1/market-analysis/runs/${id}/reports/${id}/details`], ['GET', `/v1/market-analysis/runs/${id}/reports/${id}/evidence`]]) {
    assert.ok(findHttpContract(method, path), path); assert.equal(classifyRoute(method, path).kind, 'session');
  }
});

test('native PostgreSQL HTTP binds actor and versions, deduplicates starts, isolates reads and retries exact failed steps', { timeout: 60000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const f = await createMarketSemanticFixture(pg.pool);
  let principal: RequestPrincipal | null = { kind: 'user', ...f.actor, role: 'member', email: 'fixture@example.test', sessionId: randomUUID() };
  let configuration: { configurationVersion: string; promptVersion: string } | null = { configurationVersion: 'config/test-v1', promptVersion: 'prompt/test-v1' };
  const app = Fastify(); t.after(() => app.close()); app.decorateRequest('authPrincipal', null);
  app.addHook('preHandler', async req => { req.authPrincipal = principal; });
  registerMarketModuleRoutes(app, new MarketModuleService({ context: f.context, modelIdentity: () => configuration }));
  const scope = { marketplace: 'US', nodeIdPath: '228013:495224:3736561:1063294', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' };
  const studyKey = randomUUID(), headers = { 'idempotency-key': studyKey };
  const createStudy = () => app.inject({ method: 'POST', url: '/v1/market-analysis/studies', payload: scope, headers });
  const created = await createStudy(); assert.equal(created.statusCode, 201, created.body); const studyId = created.json().study.id;
  assert.equal((await createStudy()).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/market-analysis/studies', headers: { 'idempotency-key': studyKey.toUpperCase() }, payload: scope })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/market-analysis/studies', headers, payload: { ...scope, nodeIdPath: '12:34' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/market-analysis/studies', headers, payload: { ...scope, organizationId: randomUUID() } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/market-analysis/studies', headers, payload: { ...scope, fromMonth: '2026-09' } })).statusCode, 400);
  const runUrl = `/v1/market-analysis/studies/${studyId}/customer-themes`, params = { memberCount: 20, poolSize: 100, newProductMonths: 6 };
  const started = await app.inject({ method: 'POST', url: runUrl, headers: { 'idempotency-key': randomUUID() }, payload: params });
  assert.equal(started.statusCode, 201, started.body); const runId = started.json().run.id;
  const duplicate = await app.inject({ method: 'POST', url: runUrl, headers: { 'idempotency-key': randomUUID() }, payload: params });
  assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.json().run.id, runId);
  const view = (await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: runId }))!;
  assert.equal(view.steps.length, 1); assert.equal(view.run.versions.configuration, configuration!.configurationVersion);
  assert.equal(view.run.versions.prompt, configuration!.promptVersion);
  for (const body of [{ ...params, versions: { model: 'expensive' } }, { ...params, poolSize: 10 }, { ...params, catalog: {} }])
    assert.equal((await app.inject({ method: 'POST', url: runUrl, headers: { 'idempotency-key': randomUUID() }, payload: body })).statusCode, 400);
  const readUrl = `/v1/market-analysis/runs/${runId}`;
  const read = await app.inject({ method: 'GET', url: readUrl }); assert.equal(read.statusCode, 200, read.body);
  const payload = MarketThemeRunResponseSchema.parse(read.json()); assert.equal(payload.run.currentReport, null);
  assert.equal(JSON.stringify(payload).includes('config/test-v1'), false); // No internal request/configuration or raw provider data in progress.
  const claim = await f.stores.steps.claimStep({ moduleRunId: runId, leaseOwnerId: randomUUID(), leaseMs: 120000 }); assert.ok(claim);
  await f.stores.steps.settleAndEnqueue({ claim, outcome: { status: 'failed', error: { code: 'invalid-data', retryable: false }, diagnostic: { secret: 'raw upstream diagnostic' } } });
  const failed = await app.inject({ method: 'GET', url: readUrl }); assert.equal(failed.json().run.steps[0].errorCode, 'invalid-data');
  assert.equal(failed.body.includes('raw upstream diagnostic'), false);
  const retryKey = randomUUID(), retry = { steps: [{ stepId: claim.stepId, failedAttemptId: claim.attemptId }] };
  const postRetry = () => app.inject({ method: 'POST', url: `${readUrl}/retry`, payload: retry, headers: { 'idempotency-key': retryKey } });
  assert.equal((await postRetry()).statusCode, 200); assert.equal((await postRetry()).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `${readUrl}/retry`, payload: retry, headers: { 'idempotency-key': randomUUID() } })).statusCode, 409);
  configuration = null;
  assert.equal((await app.inject({ method: 'GET', url: readUrl })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: runUrl, payload: params, headers: { 'idempotency-key': randomUUID() } })).statusCode, 503);
  const cancel = await app.inject({ method: 'POST', url: `${readUrl}/cancel`, payload: {}, headers: { 'idempotency-key': randomUUID() } }); assert.equal(cancel.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: readUrl })).json().run.status, 'cancelled');
  principal = { ...principal!, organizationId: randomUUID() } as RequestPrincipal;
  assert.equal((await app.inject({ method: 'GET', url: readUrl })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/market-analysis/studies/${studyId}` })).statusCode, 404);
  principal = null; assert.equal((await app.inject({ method: 'GET', url: readUrl })).statusCode, 401);

  await t.test('production same-origin proxy and secured Fastify assembly round-trip a native empty report', async () => {
    principal = { kind: 'user', ...f.actor, role: 'member', email: 'fixture@example.test', sessionId: randomUUID() };
    configuration = { configurationVersion: 'config/test-v1', promptVersion: 'prompt/test-v1' };
    const token = 'B'.repeat(43), origin = 'http://market.test', proxyToken = 'synthetic-market-proxy-token';
    const secured = buildAgentApp({ marketModuleService: new MarketModuleService({ context: f.context, modelIdentity: () => configuration }),
      env: { AGENT_SERVICE_PROXY_TOKEN: proxyToken, AGENT_SERVICE_TRUSTED_ORIGINS: origin }, userPresenceAccess: null,
      authConfig: { mode: 'authenticated', cookie: { name: 'agent_session', secure: false, maxAgeSeconds: 3600 }, sessionTtlMs: 3600000,
        loginLimiter: { windowMs: 60000, maxFailures: 5, maxEntries: 100 } },
      authService: { authenticate: async (value: string | null) => value === token ? principal : null } as AuthenticationService });
    t.after(() => secured.close());
    const address = await secured.listen({ host: '127.0.0.1', port: 0 });
    const client = createAgentServiceClient({ env: { AGENT_SERVICE_INTERNAL_URL: address, AGENT_SERVICE_PROXY_TOKEN: proxyToken } });
    async function proxy(method: string, path: string, body?: unknown, withCookie = true) {
      const req = new Request(`${origin}/api/agent${path}`, { method, headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(),
        ...(withCookie ? { cookie: `agent_session=${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return proxyAgentRequest(req, { params: Promise.resolve({ path: path.split('?')[0].slice(1).split('/') }) }, client);
    }
    assert.equal((await proxy('GET', `/v1/market-analysis/studies/${studyId}`, undefined, false)).status, 401);
    assert.equal((await secured.inject({ method: 'GET', url: `/v1/market-analysis/studies/${studyId}` })).statusCode, 401);
    const newStudy = await proxy('POST', '/v1/market-analysis/studies', scope); assert.equal(newStudy.status, 201);
    const securedStudyId = (await newStudy.json()).study.id;
    const queued = await proxy('POST', `/v1/market-analysis/studies/${securedStudyId}/customer-themes`, {}); assert.equal(queued.status, 201);
    const queuedRun = MarketThemeRunResponseSchema.parse(await queued.json()).run;
    let sourceCalls = 0;
    const source = (id: 'sellerSprite' | 'sorftime'): RemoteMcpConnector => ({ id, probe: async () => { throw new Error('unused'); }, execute: async r => {
      sourceCalls++; assert.equal(r.operation, 'market_product_concentration');
      return { data: { code: 'OK', data: [] }, source: { connectorId: id, operation: r.operation, fetchedAt: new Date().toISOString(), attemptCount: 1 } };
    } });
    const worker = new MarketModuleStepWorker({ steps: f.stores.steps, handlers: {
      ...createMarketSourceStepHandlers({ context: f.context, connectors: { sellerSprite: source('sellerSprite'), sorftime: source('sorftime') } }),
      'prepare-members': createMarketSourceProjectionStep(f.context), report: createMarketThemeReportStep(f.context) } });
    t.after(() => worker.stop());
    for (let i = 0; i < 5; i++) if (!await worker.tick()) break;
    const saved = await proxy('GET', `/v1/market-analysis/runs/${queuedRun.id}`); assert.equal(saved.status, 200);
    const report = MarketThemeRunResponseSchema.parse(await saved.json()).run;
    assert.equal(report.currentReport!.report.status, 'no-data'); assert.equal(report.history.length, 1);
    assert.equal(sourceCalls, 1); assert.equal(report.steps.some(s => s.kind === 'model-batch'), false);
    assert.equal((await proxy('GET', `/v1/market-analysis/runs/${queuedRun.id}`)).status, 200); assert.equal(sourceCalls, 1);
    const detailsUrl = `/v1/market-analysis/runs/${queuedRun.id}/reports/${report.currentReport!.attemptId}/details`;
    const details = await proxy('GET', `${detailsUrl}?section=members&limit=2`); assert.equal(details.status, 200);
    const detailsBody = await details.json(); assert.deepEqual(detailsBody.page.items, []); assert.equal(detailsBody.page.totals, null);
    assert.equal(detailsBody.page.limit, 2); assert.equal(detailsBody.report.attemptId, report.currentReport!.attemptId);
    assert.equal((await proxy('GET', `${detailsUrl}?limit=51`)).status, 400);
    assert.equal((await proxy('GET', detailsUrl, undefined, false)).status, 401);
    const evidenceUrl=detailsUrl.replace(/details$/,'evidence');
    assert.equal((await proxy('GET',`${evidenceUrl}?sourceThemeId=absent`)).status,404);
    assert.equal((await proxy('GET',`${evidenceUrl}?sourceThemeId=absent`,undefined,false)).status,401);
    assert.equal((await proxy('GET',`${evidenceUrl}?sourceThemeId=absent&agentRunId=${randomUUID()}`)).status,400);
  });
});
