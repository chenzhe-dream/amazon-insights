import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MarketModelBudgetCoordinator } from '../../server/runtime/market-model-budget-coordinator';
import type { MarketModelBudgetRepository, MarketBudgetReservationRecord } from '../../server/db/market-model-budget-repository';

const now = new Date('2026-09-12T10:00:00.000Z');
const subject = {
  kind: 'market-module-run' as const, organizationId: randomUUID(), studyId: randomUUID(),
  moduleRunId: randomUUID(), stepId: randomUUID(), attemptId: randomUUID(),
  leaseOwnerId: randomUUID(), leaseGeneration: 2, dataCutoffAt: now.toISOString(),
};
const authority = { ...subject, agentRunId: randomUUID(), claimToken: randomUUID() };
const limits = { call: { maxTokens: 100, maxCostMicros: 100 }, run: { maxTokens: 200, maxCostMicros: 200 }, organizationUtcDay: { maxTokens: 300, maxCostMicros: 300 } };
const request = { idempotencyKey: 'request-one', requestFingerprint: 'a'.repeat(64), projected: { inputTokens: 10, outputTokens: 20, costMicros: 3 }, request: { ordinal: 0, kind: 'initial' as const, transientRetryCount: 0, formatRepair: false }, authority };

function fixture() {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const reservation: MarketBudgetReservationRecord = {
    id: randomUUID(), kind: 'market-module-run', idempotencyKey: request.idempotencyKey, requestFingerprint: request.requestFingerprint,
    organizationId: subject.organizationId, studyId: subject.studyId, moduleRunId: subject.moduleRunId,
    stepId: subject.stepId, attemptId: subject.attemptId, agentRunId: authority.agentRunId,
    utcDay: '2026-09-12', state: 'reserved', projected: request.projected, actual: null,
    leaseExpiresAt: '2026-09-12T10:01:00.000Z', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    dispatchedAt: null, settledAt: null, releasedAt: null,
  };
  const repository: MarketModelBudgetRepository = {
    async resolveSubject(input) { calls.push({ operation: 'resolve', input }); return { organizationId: input.organizationId, studyId: input.studyId, moduleRunId: input.moduleRunId }; },
    async reserve(input) { calls.push({ operation: 'reserve', input }); return { reservation, created: true }; },
    async getUsage(input) { calls.push({ operation: 'usage', input }); return { run: { tokens: 0, costMicros: 0 }, organizationUtcDay: { tokens: 0, costMicros: 0 } }; },
    async dispatch(input) { calls.push({ operation: 'dispatch', input }); return { reservation, transitioned: true }; },
    async release(input) { calls.push({ operation: 'release', input }); return { reservation, transitioned: true }; },
    async settle(input) { calls.push({ operation: 'settle', input }); return { reservation, transitioned: true }; },
  };
  const coordinator = new MarketModelBudgetCoordinator({ repository, limitProvider: { getLimits: input => { calls.push({ operation: 'limits', input }); return limits; } }, clock: () => now, createId: () => reservation.id });
  return { calls, repository, reservation, coordinator };
}

test('native market admission carries real study/run authority and no legacy project identities', async () => {
  const f = fixture();
  assert.equal((await f.coordinator.reserve(request)).id, f.reservation.id);
  assert.deepEqual(f.calls.map(c => c.operation), ['resolve', 'limits', 'reserve']);
  const admitted = f.calls[2].input as Record<string, unknown>;
  assert.deepEqual(admitted.authority, authority);
  assert.deepEqual(admitted.limits, limits);
  assert.equal(admitted.reservedAt, now.toISOString());
  assert.equal(admitted.leaseExpiresAt, '2026-09-12T10:01:00.000Z');
  assert.equal(JSON.stringify(f.calls).includes('projectId'), false);
  assert.equal(JSON.stringify(f.calls).includes('jobAttemptId'), false);
});

test('repository subject mismatch never reaches limit calculation or reservation', async () => {
  const f = fixture();
  f.repository.resolveSubject = async () => ({ organizationId: randomUUID(), studyId: subject.studyId, moduleRunId: subject.moduleRunId });
  await assert.rejects(() => f.coordinator.reserve(request));
  assert.deepEqual(f.calls, []);
});

test('missing or mixed attempt authority and invalid request ordinals fail before persistence', async () => {
  const invalid = [
    { ...request, authority: undefined },
    { ...request, authority: { ...authority, projectId: randomUUID() } },
    { ...request, authority: { ...authority, leaseGeneration: 0 } },
    { ...request, request: { ...request.request, ordinal: 4 } },
    { ...request, request: { ...request.request, ordinal: 1 } },
    { ...request, projected: { ...request.projected, inputTokens: -1 } },
  ];
  for (const value of invalid) {
    const f = fixture();
    await assert.rejects(() => f.coordinator.reserve(value as typeof request));
    assert.deepEqual(f.calls, []);
  }
});

test('all transition methods retain complete native authority and server timestamps', async () => {
  const f = fixture();
  await f.coordinator.dispatch(f.reservation.id, authority);
  await f.coordinator.release(f.reservation.id, authority);
  await f.coordinator.settle(f.reservation.id, request.projected, 'response-one', authority);
  for (const { input } of f.calls) {
    const value = input as Record<string, unknown>;
    assert.deepEqual(value.authority, authority);
    assert.equal(value.transitionedAt, now.toISOString());
  }
  assert.equal((f.calls[2].input as Record<string, unknown>).responseId, 'response-one');
});

test('invalid clocks and invalid resolved policy cannot reserve a request', async () => {
  for (const mode of ['clock', 'policy']) {
    const f = fixture();
    const coordinator = new MarketModelBudgetCoordinator({ repository: f.repository,
      clock: () => mode === 'clock' ? new Date(NaN) : now,
      limitProvider: { getLimits: () => ({ ...limits, call: { maxTokens: -1, maxCostMicros: 100 } }) },
    });
    await assert.rejects(() => coordinator.reserve(request));
    assert.equal(f.calls.some(c => c.operation === 'reserve'), false);
  }
});
