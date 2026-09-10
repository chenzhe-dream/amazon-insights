import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { TrafficDetailRecoveryService } from '../../server/services/traffic-detail-recovery-service';
import { normalizeListingDetails } from '../../server/services/traffic-listing-collection';

const org = randomUUID(), actorId = randomUUID(), projectId = randomUUID(), runId = randomUUID(), snapshotId = randomUUID();
const asins = ['B01E6CX34C', 'B07Y4PJJR4', 'B07WFC14VR'];
const now = new Date().toISOString();
const overview = { total: 100, overview: { nf: { score: 100, ratio: 1 }, ad: { score: 0, ratio: 0 } }, ad: {}, recommend: {} };
const structure = { chars: { dims: [], nfs: [], sps: [], recs: [], sbs: [], sbvs: [] } };
function fixture(options: { reject?: boolean; timeout?: boolean } = {}) {
  const rows: any[] = []; let calls = 0;
  const repository = {
    findUserById: async () => ({ id: actorId, organizationId: org, status: 'active', role: 'admin' }),
    findAnalysisRun: async () => ({ id: runId, projectId, dataCutoffAt: now }),
    findProjectById: async () => ({ id: projectId, organizationId: org, marketplace: 'US', asins }),
    listTrafficDataSnapshotsByRun: async () => [{ id: snapshotId }],
    trafficDetailRecoveries: {
      findById: async (input: any) => rows.find(row => row.collection.id === input.id) ?? null,
      append: async (input: any) => { rows.push(input); return input; },
    },
  };
  const connector = { id: 'sif', probe: async () => { throw new Error('unused'); }, execute: async (request: any) => {
    calls++;
    if (options.reject) throw new Error('private-error-do-not-return');
    if (options.timeout) return new Promise(() => {});
    return { data: request.operation.endsWith('overview') ? overview : structure, source: { connectorId: 'sif', operation: request.operation, fetchedAt: now, attemptCount: 1 } };
  } };
  const service = new TrafficDetailRecoveryService({ repository: repository as never, connector: connector as never, timeoutMs: options.timeout ? 20 : 1000 });
  return { service, rows, calls: () => calls };
}
const principal = { organizationId: org, actorId, runId };
test('recovery publishes exactly one full batch and successful replay does not recollect', async () => {
  const f = fixture(), requestId = randomUUID();
  const first = await f.service.recover({ ...principal, requestId });
  const second = await f.service.recover({ ...principal, requestId });
  assert.deepEqual(first, second);
  assert.equal(f.calls(), 6);
  assert.equal(f.rows.length, 1);
  assert.deepEqual(first.records[asins[0]], normalizeListingDetails(overview, structure));
});
test('foreign organization is rejected before provider requests', async () => {
  const f = fixture();
  await assert.rejects(f.service.recover({ ...principal, organizationId: randomUUID(), requestId: randomUUID() }), /scope|not found/i);
  assert.equal(f.calls(), 0);
});
test('failure publishes nothing and never returns provider secrets', async () => {
  const f = fixture({ reject: true });
  await assert.rejects(f.service.recover({ ...principal, requestId: randomUUID() }), (e: any) => !e.message.includes('private-error'));
  assert.equal(f.rows.length, 0);
});
test('ignored provider deadline cannot write a late recovery', async () => {
  const f = fixture({ timeout: true });
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(f.service.recover({ ...principal, requestId: randomUUID() }), /超时|timeout/i); }
  finally { clearTimeout(keepAlive); }
  assert.equal(f.rows.length, 0);
});
test('concurrent different request IDs are rejected instead of receiving another request receipt', async () => {
  const f = fixture({ timeout: true });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    const first = f.service.recover({ ...principal, requestId: randomUUID() });
    const firstSettled = assert.rejects(first);
    await new Promise(resolve => setTimeout(resolve, 1));
    await assert.rejects(f.service.recover({ ...principal, requestId: randomUUID() }), (error: any) => error.statusCode === 409);
    await firstSettled;
  } finally { clearTimeout(keepAlive); }
});
