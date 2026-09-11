import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createAgentService } from '../../server/agent-service';
import type { RuntimeAgentRepository } from '../../server/db/repository';
import { openSqliteAgentRepository } from '../../server/db/sqlite-repository';
import type { ProductDefinitionInput } from '../../server/domain/product/product-definition-contracts';
import { preprocessVocSnapshot } from '../../server/domain/voc/preprocess-voc-snapshot';
import type { ModelProvider, StructuredGenerationRequest } from '../../server/runtime/model-provider';
import { canonicalJsonSha256 } from '../../server/runtime/model-request-accounting';
import { AnalysisRunService } from '../../server/services/analysis-run-service';
import { VocAutomationService } from '../../server/services/voc-automation-service';
import oldSkillManifests from './helpers/pre-evidence-skill-manifests.json';
import { runtimeEnv, validProductOutput } from './helpers/voc-evidence-runtime-fixture';
import { validAmazonVocInsightOutput } from './helpers/voc-positioning-fixture';

const ASINS = ['B08L7DD8L9', 'B07498JDX4', 'B0829MZFDP'];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const failFirst of [false, true]) test(`durable VOC automation drives actual worker chain${failFirst ? ' and explicit failed-run retry' : ''}`, async t => {
  const repository = openSqliteAgentRepository({ path: ':memory:', busyTimeoutMs: 5000 });
  const organizationId = randomUUID(), actorId = randomUUID(), projectId = randomUUID(), baseSyncRunId = randomUUID();
  const now = '2026-09-10T00:00:00.000Z';
  await repository.createUser({ id: actorId, organizationId, email: `${actorId}@example.invalid`, displayName: 'Fixture', role: 'member', status: 'active', createdAt: now, updatedAt: now });
  await repository.createProject({ id: projectId, organizationId, name: 'Automation fixture', marketplace: 'US', asins: ASINS, createdBy: actorId, createdAt: now, updatedAt: now });
  await repository.createAnalysisRun({ id: baseSyncRunId, projectId, createdBy: actorId, mode: 'existing-data', status: 'succeeded', dataCutoffAt: now, idempotencyScope: `sync:${organizationId}:${projectId}`, idempotencyKey: 'job', createdAt: now, updatedAt: now });
  const reviewData = { analysisByAsin: { [ASINS[0]]: { asin: ASINS[0], marketplace: 'US', status: 'ready', fetchedAt: '2026-09-09', sampledReviews: 2, blocks: [{ key: 'negatives', label: '问题', rows: [{ label: '结构断裂', reason: '支架断裂', sharePct: 50 }] }] } }, ratingByAsin: {} };
  const keywordData = { analysisByAsin: { [ASINS[0]]: { asin: ASINS[0], marketplace: 'US', status: 'ready', fetchedAt: '2026-09-09', keywords: [{ keyword: 'reading light', searchVolume: 123 }] } }, enrichmentByKeyword: {} };
  const stageOutput = (stage: string, data: unknown) => ({ projectId, runId: baseSyncRunId, jobId: 'job', jobVersion: 1, outputVersion: 1, stage, stageStatus: 'done', updatedAt: '2026-09-09T23:59:59.999Z', data, contentHash: canonicalJsonSha256({ stage, data }) });
  let keywordsAvailable = false;
  const syncJobs = {
    findById: async () => ({ jobId: 'job', organizationId, projectId, runId: baseSyncRunId, marketplace: 'US', asins: ASINS }),
    readStageOutput: async ({ stage }: { stage: string }) => stage === 'reviews' ? stageOutput(stage, reviewData) : stage === 'keywords' && keywordsAvailable ? stageOutput(stage, keywordData) : null,
  };
  const wrap = (repo: typeof repository): RuntimeAgentRepository => new Proxy(repo, { get(target, key) {
    if (key === 'syncJobs') return syncJobs;
    if (key === 'transaction') return (fn: (r: RuntimeAgentRepository) => Promise<unknown>) => target.transaction(transaction => fn(wrap(transaction as typeof repository)));
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as unknown as RuntimeAgentRepository;
  const wrapped = wrap(repository);
  const scope = { organizationId, actorId, projectId };
  const request = { baseSyncRunId, selectedAsins: [ASINS[0]] };
  const errors: unknown[] = [];
  let automation = new VocAutomationService({ repository: wrapped, onError: error => errors.push(error) });
  const initial = await automation.register(scope, request);
  assert.equal(initial.state, 'waiting-voc');
  assert.equal(initial.runId, null);
  assert.equal((await repository.listAnalysisRuns(projectId)).length, 1);

  const manualRecord = { asin: ASINS[0], captureStatus: 'dialog', alexaReport: { asin: ASINS[0], title: 'Fixture', rating: 4, reviewCount: 99, prompt: 'Fixture', overallConclusion: 'Fixture' }, attention: [], positives: [], negatives: ['结构断裂'], unmet: [], audiences: [], scenarios: [], motives: [] };
  await repository.transaction(async raw => {
    const transaction = raw as typeof repository;
    await transaction.manualAlexaVoc.lockScopes({ organizationId, marketplace: 'US', asins: [ASINS[0]] });
    const expectedRevision = await transaction.manualAlexaVoc.peekNextRevision({ organizationId, marketplace: 'US', asin: ASINS[0] });
    await transaction.manualAlexaVoc.put({ organizationId, marketplace: 'US', asin: ASINS[0], createdBy: actorId, expectedRevision, normalizedRecord: manualRecord as never, normalizedSchemaVersion: 'alexa-voc-record/v2', parserVersion: 'deterministic-alexa-parser/v3', contentHash: canonicalJsonSha256(manualRecord), raw: { algVersion: 'AES-256-GCM/v1', keyId: 'fixture', wrappedDek: randomBytes(60), nonce: randomBytes(12), ciphertext: randomBytes(48), tag: randomBytes(16), aadSha256: 'a'.repeat(64), plaintextBytes: 48, plaintextSha256: 'b'.repeat(64) } });
  });
  // A fresh service discovers the saved intent without any browser registration or createRun call.
  automation = new VocAutomationService({ repository: wrapped, onError: error => errors.push(error) });
  await automation.tick();
  assert.equal((await automation.read(scope)).state, 'waiting-keywords');
  assert.equal((await repository.listAnalysisRuns(projectId)).length, 1);

  let vocCalls = 0, productCalls = 0, rejectProduct = failFirst;
  const provider: ModelProvider = { async generateStructured<T>(generation: StructuredGenerationRequest<T>) {
    const input = generation.input as { kind: string };
    let value: unknown;
    if (input.kind === 'voc-positioning-input') {
      vocCalls++;
      const record = await repository.vocAutomations.get(organizationId, projectId);
      assert.ok(record?.runId);
      const snapshots = await repository.listDataSnapshotsByRun({ actorOrganizationId: organizationId, runId: record.runId });
      value = validAmazonVocInsightOutput(preprocessVocSnapshot(snapshots[0]));
    } else {
      assert.equal(input.kind, 'amazon-product-definition-input');
      productCalls++;
      const productInput = generation.input as ProductDefinitionInput;
      assert.deepEqual(productInput.asins, request.selectedAsins);
      assert.equal(productInput.evidenceSelection?.sourcePolicy, 'manual-only');
      value = rejectProduct ? {} : { ...validProductOutput(productInput), opportunity: { grade: 'B', scope: 'demand-and-product-definition-opportunity', projectApproval: 'not-approved' } };
    }
    return { value: value as T, responseId: 'automation-fixture', inputTokens: 100, outputTokens: 50 };
  } };
  for (const manifest of oldSkillManifests) await repository.registerSkillVersion({ id: randomUUID(), skillId: manifest.id, version: manifest.version, contentHash: manifest.contentHash, manifest, createdAt: now });
  const runtime = await createAgentService({ repository: wrapped, provider, providerName: 'automation-fixture', env: runtimeEnv(':memory:') });
  t.after(async () => { await automation.stop(); await runtime.stop(); repository.close(); });
  await runtime.start({ host: '127.0.0.1', port: 0 });
  await sleep(100);
  assert.equal(vocCalls, 0);
  assert.equal(productCalls, 0);
  // Only the data readiness changes. The runtime's background reconciler must start the chain.
  keywordsAvailable = true;
  const waitForState = async (expected: 'succeeded' | 'failed') => {
    const deadline = Date.now() + 10_000;
    let status = await automation.read(scope);
    while (Date.now() < deadline && status.state !== expected) {
      await sleep(25);
      status = await automation.read(scope);
    }
    assert.equal(status.state, expected, JSON.stringify({ status, errors }));
    return status;
  };
  const terminal = await waitForState(failFirst ? 'failed' : 'succeeded');
  assert.ok(terminal.runId);
  assert.equal(vocCalls, 1);
  assert.ok(productCalls >= 1);
  const firstRunId = terminal.runId;
  assert.equal((await repository.listAnalysisRuns(projectId)).length, 2);
  const lifecycle = new AnalysisRunService({ repository: wrapped, executionContext: { actorId, organizationId } });
  const firstReports = (await lifecycle.listReports(firstRunId)).reports;
  assert.equal(firstReports.filter(report => report.stage === 'voc-positioning').length, 1);
  assert.equal(firstReports.filter(report => report.stage === 'product-definition').length, failFirst ? 0 : 1);

  for (let repeat = 0; repeat < 3; repeat++) await automation.tick();
  assert.equal((await automation.register(scope, request)).runId, firstRunId);
  assert.equal((await repository.listAnalysisRuns(projectId)).length, 2, 'unchanged input never creates another run, including after failure');
  if (failFirst) {
    rejectProduct = false;
    const retry = await automation.register(scope, { ...request, retryKey: randomUUID() });
    assert.ok(retry.runId);
    assert.notEqual(retry.runId, firstRunId);
    const succeeded = await waitForState('succeeded');
    assert.equal(succeeded.runId, retry.runId);
    assert.equal((await repository.listAnalysisRuns(projectId)).length, 3);
    assert.equal((await lifecycle.listReports(retry.runId)).reports.filter(report => report.stage === 'product-definition').length, 1);
    assert.equal(vocCalls, 2);
    await automation.tick();
    assert.equal((await repository.listAnalysisRuns(projectId)).length, 3);
  }
  assert.deepEqual(errors, []);
});
