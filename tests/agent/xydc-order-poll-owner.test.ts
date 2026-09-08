import assert from "node:assert/strict";
import { test } from "node:test";
import type { XydcOrderProgressView } from "../../shared/xydc-order-progress";
import { createXydcOrderPollOwner } from "../../app/lib/use-xydc-order-progress";

const active: XydcOrderProgressView = { currentRunId: "run", jobId: "job", leaseGeneration: 1, activeJob: true, progress: null };
const terminal: XydcOrderProgressView = { ...active, progress: { state: "partial", ready: 2, cached: 1, total: 3,
  updatedAt: "2026-09-08T00:00:00.000Z", retryAt: null, safeReason: "RPC_ERROR" } };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
test("one five-second owner performs one terminal refresh then stops despite active sync job", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-09-08T00:00:00Z") });
  let reads = 0;
  const owner = createXydcOrderPollOwner(async () => { reads++; return terminal; });
  owner.update(active);
  t.mock.timers.tick(4999); await flush(); assert.equal(reads, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(reads, 2);
  owner.update(terminal);
  t.mock.timers.tick(60_000); await flush(); assert.equal(reads, 2);
  owner.dispose();
});
test("hidden and disposed scope abort actual commit guard and ignore an uncooperative old fetch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish: (() => void) | undefined;
  let commit = 0;
  let requests = 0;
  let observedSignal: AbortSignal | undefined;
  const owner = createXydcOrderPollOwner(async (signal, current) => {
    requests++; observedSignal = signal;
    await new Promise<void>(resolve => { finish = resolve; });
    if (!signal.aborted && current()) commit++;
    return active;
  });
  owner.update(active);
  t.mock.timers.tick(5_000); await flush();
  t.mock.timers.tick(20_000); await flush(); assert.equal(requests, 1);
  owner.setVisible(false); assert.equal(observedSignal?.aborted, true);
  finish?.(); await flush(); assert.equal(commit, 0);
  owner.setVisible(true); t.mock.timers.tick(5_000); await flush(); assert.equal(requests, 2);
  owner.dispose(); finish?.(); await flush(); assert.equal(commit, 0);
});
test("no task or terminal-only history never polls; changed generation invalidates old response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  let release: (() => void) | undefined;
  let commits = 0;
  const owner = createXydcOrderPollOwner(async (signal, current) => {
    reads++; await new Promise<void>(resolve => { release = resolve; });
    if (!signal.aborted && current()) commits++;
    return active;
  });
  owner.update(null); t.mock.timers.tick(10_000); await flush();
  owner.update(terminal); t.mock.timers.tick(10_000); await flush(); assert.equal(reads, 0);
  owner.update(active); t.mock.timers.tick(5_000); await flush(); assert.equal(reads, 1);
  owner.update({ ...active, leaseGeneration: 2 }); release?.(); await flush(); assert.equal(commits, 0);
  owner.dispose();
});

test("discovery shares visibility, commit epoch and single flight with the five-second poll", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  let commits = 0;
  let release: (() => void) | undefined;
  const owner = createXydcOrderPollOwner(async (signal, current) => {
    reads++;
    await new Promise<void>(resolve => { release = resolve; });
    if (!signal.aborted && current()) commits++;
    return active;
  });
  owner.update(active);
  owner.discover?.();
  await flush(); assert.equal(reads, 1);
  t.mock.timers.tick(10_000); await flush(); assert.equal(reads, 1);
  owner.setVisible(false); release?.(); await flush(); assert.equal(commits, 0);
  t.mock.timers.tick(10_000); await flush(); assert.equal(reads, 1);
  owner.setVisible(true); await flush(); assert.equal(reads, 2);
  release?.(); await flush(); assert.equal(commits, 1);
  t.mock.timers.tick(4_999); await flush(); assert.equal(reads, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(reads, 3);
  owner.dispose(); release?.(); await flush();
});
