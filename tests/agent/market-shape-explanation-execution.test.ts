import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresMarketShapeExplanationRunStore } from '../../server/db/postgres/market-shape-explanation-run-store';
import { PostgresMarketAgentRunStore } from '../../server/db/postgres/market-agent-run-store';
import { buildMarketShapeExplanationWindows, decodeMarketShapeExplanationWindow } from '../../server/domain/market-research/shape-explanation-wire';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { loadMarketShapeExplanationCatalog } from '../../server/services/market-shape-explanation-input-service';
import { MarketSemanticBatchPreparationService } from '../../server/runtime/market-semantic-batch-preparation';
import { MarketSemanticExecutionService } from '../../server/runtime/market-semantic-execution-service';
import { SkillRegistry } from '../../server/skills/registry';
import type { MarketShapeStructureExplanationInput } from '../../shared/market-semantic-contracts';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { createMarketShapeExplanationRunFixture } from './helpers/market-shape-explanation-run-fixture';
import { startFakeOpenAIResponsesServer } from './helpers/fake-openai-responses-server';

test('representative A2 windows execute through native preparation, SkillRunner and audit', { timeout: 120_000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const registry = await SkillRegistry.open('skills-src');
  const f = await createMarketShapeExplanationRunFixture(pg.pool);
  const configurationVersion = 'shape-native-execution/v1', promptVersion = 'shape-native-prompt/v1';
  const linked = await new PostgresMarketShapeExplanationRunStore(f.context).saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId, request: f.request, idempotencyKey: randomUUID(), identity: { configurationVersion, promptVersion } });
  const catalog = await loadMarketShapeExplanationCatalog(f.context, f.actor, linked.childRun.id);
  const allWindows = await buildMarketShapeExplanationWindows(catalog, async () => true);
  const windows = allWindows.filter(window => window.rows.length > 0).slice(0, 2);
  assert.ok(windows.length >= 1); // Execute representative windows while preserving the complete continuation manifest.
  const inputs = allWindows.map(window => ({ scope: f.scope, kind: 'overview' as const, sourceVersion: catalog.version,
    ruleVersion: 'shape-explanation/v1', collectedAt: catalog.source.dataCutoffAt, expectedRecordIds: [window.windowId],
    records: [{ id: window.windowId, scope: f.scope, data: { semantic: { task: 'market-shape-structure-explanation' as const, window, sourceRefs: catalog.source.sourceRefs } } }] }));
  const snapshots = inputs.map(input => createMarketInputSnapshot(input));
  const anchor = await f.steps.claimStep({ moduleRunId: linked.childRun.id, kinds: ['prepare-members'], leaseOwnerId: randomUUID(), leaseMs: 120_000 }); assert.ok(anchor);
  const settled = await f.steps.settleAndEnqueue({ claim: anchor, outcome: { status: 'succeeded', output: {
    manifestVersion: 'shape-explanation-windows/v2', sourceRefs: catalog.source.sourceRefs,
    explanationCatalogId: catalog.explanationCatalogId, revisionId: catalog.revisionId, windows: allWindows,
  } }, inputs, children: snapshots.map(snapshot => ({
    stepKey: `shape-explanation/model-input/${snapshot.snapshotId}`, kind: 'prepare-model-batches', subject: { task: 'market-shape-structure-explanation' },
    input: { task: 'market-shape-structure-explanation', inputSnapshotId: snapshot.snapshotId, selectionRevision: catalog.revisionId, dataCutoffAt: catalog.source.dataCutoffAt }, inputRefs: [{ kind: 'input', id: snapshot.snapshotId }],
  })) });
  assert.equal(settled.status, 'committed'); assert.deepEqual(new Set(settled.inputIds), new Set(snapshots.map(snapshot => snapshot.snapshotId)));
  const selectedSnapshotIds = new Set(windows.map(window => snapshots[allWindows.indexOf(window)].snapshotId));
  const prepareClaims = [];
  for (const _window of allWindows) {
    const claim = await f.steps.claimStep({ moduleRunId: linked.childRun.id, kinds: ['prepare-model-batches'], leaseOwnerId: randomUUID(), leaseMs: 120_000 }); assert.ok(claim);
    const input = claim.step.input;
    assert.ok(input && typeof input === 'object' && !Array.isArray(input));
    assert.equal(typeof input.inputSnapshotId, 'string');
    if (selectedSnapshotIds.has(String(input.inputSnapshotId))) prepareClaims.push(claim);
  }
  assert.equal(prepareClaims.length, windows.length);
  let requests = 0;
  const server = await startFakeOpenAIResponsesServer(body => {
    requests++;
    const input = JSON.parse(body.input) as MarketShapeStructureExplanationInput;
    assert.equal('shapeExplanationCatalog' in input, false); assert.equal('catalog' in input, false);
    const decoded = decodeMarketShapeExplanationWindow(catalog, input.window), row = decoded.rows[0], cell = row.cells.find(item => item.value !== null)!;
    assert.ok(cell);
    const selectedCellId = input.window.windowId === windows[1]?.windowId ? 'forged-cell' : cell.id;
    const statement = { kind: 'observed' as const, parts: [{ kind: 'text' as const, text: 'The recorded value is ' }, { kind: 'cell' as const, rowId: row.id, cellId: selectedCellId }], evidenceRowIds: [row.id], limitationCodes: [] };
    const verification = { kind: 'verification' as const, parts: [{ kind: 'text' as const, text: 'Verify against an independently collected comparable source.' }], evidenceRowIds: [row.id], limitationCodes: [] };
    const limitationCodes = decoded.limitations.map(item => item.code);
    const limitation = { kind: 'risk' as const, parts: [{ kind: 'text' as const, text: 'Treat this selected source pool as exploratory evidence.' }], evidenceRowIds: [row.id], limitationCodes };
    return { schemaVersion: '1.0.0', task: input.task, batchId: input.batchId, inputDigest: input.inputDigest,
      fragment: { version: 'market-shape-explanation-fragment/v1', explanationCatalogId: catalog.explanationCatalogId, revisionId: catalog.revisionId, windowId: input.window.windowId,
        section: { dimension: input.window.dimension, status: 'explained', summary: statement, findings: [statement], limitations: [limitation], verification: [verification] } } };
  });
  t.after(() => server.close());
  const cap = { maxTokens: 100_000, maxCostMicros: 1_000_000 };
  const configuration = { task: 'market-shape-structure-explanation' as const, configurationVersion, providerName: 'local-fake-openai', transport: 'responses-strict' as const,
    model: { name: 'shape-fixture-model', estimatedInputTokens: 12_000, maxOutputTokens: 4_000, timeoutMs: 60_000, pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } },
    limits: { call: cap, run: cap, organizationUtcDay: cap }, openAI: { apiKey: 'test-key', baseUrl: server.baseUrl } };
  for (const prepareClaim of prepareClaims) {
    const prepared = await new MarketSemanticBatchPreparationService(f.context, registry).prepareBatches(prepareClaim, configuration);
    const manifest = prepared.manifest as { batches: Array<{ bindingId: string }> }; assert.equal(manifest.batches.length, 1);
  }
  const audit = new PostgresMarketAgentRunStore(f.context), execution = new MarketSemanticExecutionService(f.context, registry);
  let succeeded = 0, failed = 0;
  for (const _expected of windows) {
    const claim = await f.steps.claimStep({ moduleRunId: linked.childRun.id, kinds: ['model-batch'], leaseOwnerId: randomUUID(), leaseMs: 120_000 }); assert.ok(claim);
    const result = await execution.executeBatch(claim, configuration);
    const binding = await audit.findSnapshotBinding({ actor: f.actor, studyId: f.scope.researchId, moduleRunId: linked.childRun.id, bindingId: result.agentRun.bindingId }); assert.ok(binding);
    assert.equal(binding.selectionRevision, catalog.revisionId); assert.equal(binding.memberRefs.length, 1);
    assert.ok(binding.inputProjection&&typeof binding.inputProjection==='object');
    assert.equal('shapeExplanationCatalog' in binding.inputProjection, false);
    const inputWindowId = (binding.inputProjection as any).window.windowId;
    if (inputWindowId === windows[1]?.windowId) {
      failed++; assert.equal(result.status, 'failed'); assert.equal(result.agentRun.validationStatus, 'failed');
    } else {
      succeeded++; assert.equal(result.status, 'succeeded', JSON.stringify(result.agentRun.outcome?.error)); assert.equal(result.value?.task, 'market-shape-structure-explanation');
      const output = result.agentRun.outcome?.output as any; assert.equal(output.fragment.windowId, inputWindowId);
      const replay = await execution.executeBatch(claim, configuration); assert.equal(replay.replayed, true);
    }
  }
  assert.equal(succeeded, 1); assert.equal(failed, windows.length - 1);
  assert.equal(requests, windows.length); const audits = await audit.listAgentRuns({ actor: f.actor, studyId: f.scope.researchId, moduleRunId: linked.childRun.id });
  assert.equal(audits.length, windows.length); assert.equal(audits.filter(item => item.validationStatus === 'passed').length, 1); assert.equal(audits.filter(item => item.validationStatus === 'failed').length, windows.length - 1);

  const newer = await new PostgresMarketShapeExplanationRunStore(f.context).saveRevisionAndEnsureExplanation({ actor: f.actor, parentRunId: f.parentRunId,
    request: { ...f.request, expectedParentRevisionId: catalog.revisionId, note: 'new revision' }, idempotencyKey: randomUUID(), identity: { configurationVersion: 'shape-native-execution/v2', promptVersion } });
  assert.notEqual(newer.explanationCatalog.explanationCatalogId, catalog.explanationCatalogId);
  await pg.pool.query('ALTER TABLE market_shape_explanation_runs DISABLE TRIGGER USER');
  await pg.pool.query('UPDATE market_shape_explanation_runs SET revision_id=$1,explanation_catalog_id=$2 WHERE child_run_id=$3', [newer.revision.catalog.revision.revisionId, newer.explanationCatalog.explanationCatalogId, linked.childRun.id]);
  await pg.pool.query('ALTER TABLE market_shape_explanation_runs ENABLE TRIGGER USER');
  await assert.rejects(loadMarketShapeExplanationCatalog(f.context, f.actor, linked.childRun.id));
});
