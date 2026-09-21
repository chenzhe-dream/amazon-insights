import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import type { MarketModuleExecutionRepository } from '../../server/db/market-module-execution-repository';
import { canonicalJsonSha256 } from '../../server/runtime/model-request-accounting';
import {
  MarketModelBatchWorker,
  MarketModelConfigurationUnavailableError,
} from '../../server/runtime/market-model-batch-worker';
import {
  MARKET_OVERVIEW_COMPLETE_FLOW_VERSION,
  MARKET_OVERVIEW_EXPANDED_FLOW_VERSION,
  MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION,
} from '../../server/domain/market-research/overview-flow';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import { startPostgresTestContainer } from './helpers/postgres-test-container';

test('restricted unavailable-model worker only closes overview v4/v5 model batches', { timeout: 120_000 }, async t => {
  const pg = await startPostgresTestContainer();
  t.after(() => pg.close());
  await runPostgresMigrations(pg.pool);
  const keyword = await createMarketSemanticFixture(pg.pool);
  await keyword.stores.steps.settleAndEnqueue({
    claim: keyword.modelClaim,
    outcome: { status: 'failed', error: { code: 'internal', retryable: false } },
  });
  await keyword.stores.steps.retryFailedSteps({
    actor: keyword.actor,
    moduleRunId: keyword.subject.moduleRunId,
    steps: [{ stepId: keyword.modelClaim.stepId, failedAttemptId: keyword.modelClaim.attemptId }],
    idempotencyKey: randomUUID(),
  });

  const createQueuedModel = async (moduleKind: 'overview' | 'shape-price', flow: string) => {
    const runId = randomUUID();
    const stepId = randomUUID();
    const request = {
      scope: keyword.scope,
      moduleKind,
      params: { flow },
      versions: { source: 'fixture/v1', rule: 'fixture/v1', mapping: 'fixture/v1', planner: flow, model: 'fixture-model', prompt: 'fixture-prompt', configuration: null },
      collectionRevision: randomUUID(),
      initialSteps: [{ stepKey: 'model/fixture', kind: 'model-batch', subject: { task: 'market-overview-synthesis' }, input: { task: 'market-overview-synthesis' }, inputRefs: [] }],
    } as const;
    const definition = request.initialSteps[0];
    await pg.pool.query(
      "INSERT INTO market_analysis_module_runs(id,organization_id,study_id,created_by,request_json,request_fingerprint,status) VALUES($1,$2,$3,$4,$5::jsonb,$6,'queued')",
      [runId, keyword.actor.organizationId, keyword.scope.researchId, keyword.actor.userId, JSON.stringify(request), canonicalJsonSha256(request)],
    );
    await pg.pool.query(
      "INSERT INTO market_analysis_steps(id,organization_id,study_id,run_id,step_key,kind,definition_json,input_hash,status) VALUES($1,$2,$3,$4,$5,'model-batch',$6::jsonb,$7,'queued')",
      [stepId, keyword.actor.organizationId, keyword.scope.researchId, runId, definition.stepKey, JSON.stringify(definition), canonicalJsonSha256(definition)],
    );
    return { runId, stepId };
  };

  const v4 = await createQueuedModel('overview', MARKET_OVERVIEW_COMPLETE_FLOW_VERSION);
  const v5 = await createQueuedModel('overview', MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION);
  const v3 = await createQueuedModel('overview', MARKET_OVERVIEW_EXPANDED_FLOW_VERSION);
  const shape = await createQueuedModel('shape-price', MARKET_OVERVIEW_COMPLETE_FLOW_VERSION);
  let executions = 0;
  const steps = new Proxy(keyword.stores.steps, {
    get(target, property, receiver) {
      if (property === 'settleAndEnqueue') return async (input: Parameters<MarketModuleExecutionRepository['settleAndEnqueue']>[0]) => {
        const outcome = input.outcome;
        await pg.pool.query(
          'UPDATE market_analysis_step_attempts SET status=$2,error_json=$3::jsonb,diagnostic_json=$4::jsonb,finished_at=clock_timestamp() WHERE id=$1',
          [input.claim.attemptId, outcome.status, JSON.stringify(outcome.status === 'failed' ? outcome.error : null), JSON.stringify(outcome.status === 'failed' ? outcome.diagnostic ?? null : null)],
        );
        await pg.pool.query(
          'UPDATE market_analysis_steps SET status=$2,lease_owner_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1',
          [input.claim.stepId, outcome.status],
        );
        return { status: 'committed' as const, attemptId: input.claim.attemptId, sourceIds: [], inputIds: [], childStepIds: [] };
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as MarketModuleExecutionRepository;
  const worker = new MarketModelBatchWorker({
    steps,
    audit: keyword.stores.audit,
    execution: { executeBatch: async () => { executions++; throw new Error('executeBatch must not run'); } },
    resolveConfiguration: () => { throw new MarketModelConfigurationUnavailableError(); },
    moduleKindsByStepKind: { 'model-batch': ['overview'] },
    flowVersionsByStepKind: { 'model-batch': [MARKET_OVERVIEW_COMPLETE_FLOW_VERSION, MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION] },
  });

  try {
    assert.equal(await worker.tick(), true);
    assert.equal(await worker.tick(), true);
    assert.equal(await worker.tick(), false);
  } finally {
    await worker.stop();
  }

  assert.equal(executions, 0);
  const attempts = await pg.pool.query<{ run_id: string; status: string; error_json: unknown; diagnostic_json: unknown }>(
    'SELECT run_id,status,error_json,diagnostic_json FROM market_analysis_step_attempts WHERE run_id=ANY($1::uuid[]) ORDER BY run_id',
    [[v4.runId, v5.runId, v3.runId, shape.runId]],
  );
  assert.deepEqual(new Set(attempts.rows.map(row => row.run_id)), new Set([v4.runId, v5.runId]));
  for (const row of attempts.rows) {
    assert.equal(row.status, 'failed');
    assert.deepEqual(row.error_json, { code: 'governance', retryable: false });
    assert.deepEqual(row.diagnostic_json, { reason: 'model-configuration-unavailable' });
  }
  const untouched = await pg.pool.query<{ status: string }>(
    'SELECT status FROM market_analysis_steps WHERE id=ANY($1::uuid[]) ORDER BY id',
    [[keyword.modelClaim.stepId, v3.stepId, shape.stepId]],
  );
  assert.deepEqual(untouched.rows.map(row => row.status), ['queued', 'queued', 'queued']);
  const audit = await keyword.stores.audit.listAgentRuns({
    actor: keyword.actor,
    studyId: keyword.scope.researchId,
    moduleRunId: keyword.subject.moduleRunId,
  });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].attemptId, keyword.modelClaim.attemptId);
});
