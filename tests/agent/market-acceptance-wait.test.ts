import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForMarketAcceptance } from '../../scripts/lib/market-acceptance-wait';

test('false ticks during durable cooldown do not end acceptance early', async () => {
  let now = 1000, ticks = 0;
  const result = await waitForMarketAcceptance({
    deadline: 10000, now: () => now, sleep: async ms => { now += ms; },
    tick: async () => { ticks++; return now >= 4000; },
    read: async () => ({ run: { status: now >= 4000 ? 'succeeded' : 'running' },
      steps: [{ status: now >= 4000 ? 'succeeded' : 'queued', nextAttemptAt: new Date(4000).toISOString() }] }),
  });
  assert.equal(result.kind, 'terminal'); assert.ok(ticks > 1); assert.ok(now >= 4000);
});
test('partial with pending work keeps polling; settled partial and failures terminate', async () => {
  for (const status of ['partial', 'failed', 'cancelled']) {
    let ticks = 0;
    const result = await waitForMarketAcceptance({ deadline: 10000, now: () => 0,
      sleep: async () => {}, tick: async () => { ticks++; return true; },
      read: async () => ({ run: { status }, steps: [{ status: ticks === 1 && status === 'partial' ? 'queued' : 'failed' }] }),
    });
    assert.equal(result.kind, 'terminal'); assert.equal(ticks, status === 'partial' ? 2 : 1);
  }
});
test('waiting obeys acceptance deadline and cancellation without treating them as success', async () => {
  let now = 0;
  const base = { deadline: 2000, now: () => now, sleep: async (ms: number) => { now += ms; },
    tick: async () => false, read: async () => ({ run: { status: 'running' }, steps: [{ status: 'queued' }] }) };
  assert.equal((await waitForMarketAcceptance(base)).kind, 'deadline');
  const controller = new AbortController(); controller.abort();
  assert.equal((await waitForMarketAcceptance({ ...base, signal: controller.signal })).kind, 'cancelled');
});
