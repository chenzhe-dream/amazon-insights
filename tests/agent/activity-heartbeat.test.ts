import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ActivityHeartbeatController,
  sendActivityHeartbeat,
  type ActivityHeartbeatScheduler,
  type ActivityHeartbeatVisibility,
} from "../../app/lib/activity-heartbeat";
import { localAgentFetch, subscribeToAuthenticationRequired } from "../../app/lib/local-agent-browser";

class FakeScheduler implements ActivityHeartbeatScheduler {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { dueAt: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.dueAt;
      timer.callback();
    }
    this.now = target;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

class FakeVisibility implements ActivityHeartbeatVisibility {
  private readonly listeners = new Set<() => void>();

  constructor(private visible: boolean) {}

  isVisible(): boolean {
    return this.visible;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const listener of [...this.listeners]) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("activity helper sends the exact empty same-origin POST and validates {ok:true}", async () => {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  const signal = new AbortController().signal;
  const result = await sendActivityHeartbeat(signal, async (path, init) => {
    calls.push({ path, init });
    return Response.json({ ok: true });
  });

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, "/v1/auth/activity");
  assert.deepEqual(Object.keys(calls[0]?.init ?? {}).sort(), ["method", "signal"]);
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.signal, signal);
  assert.equal(calls[0]?.init?.body, undefined);
  assert.deepEqual([...new Headers(calls[0]?.init?.headers).entries()], []);
});

test("activity helper swallows temporary, non-OK, and malformed responses", async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 503 }),
    async () => Response.json({ ok: false }),
    async () => Response.json({ ok: true, sessionIdentity: "must-not-pass" }),
    async () => { throw new Error("temporary network failure"); },
  ]) {
    assert.equal(await sendActivityHeartbeat(new AbortController().signal, fetchImpl), false);
  }
});

test("activity helper reuses localAgentFetch authentication-required notification on 401", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  let authenticationRequired = 0;
  const unsubscribe = subscribeToAuthenticationRequired(() => { authenticationRequired += 1; });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return Response.json(
      { error: { code: "AUTHENTICATION_REQUIRED", message: "expired", requestId: "heartbeat-401" } },
      { status: 401 },
    );
  }) as typeof fetch;

  try {
    assert.equal(await sendActivityHeartbeat(new AbortController().signal, localAgentFetch), false);
  } finally {
    globalThis.fetch = originalFetch;
    unsubscribe();
  }

  assert.equal(authenticationRequired, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/agent/v1/auth/activity");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.body, undefined);
});

test("visible controller attempts immediately and once per completed 60-second cycle", async () => {
  const scheduler = new FakeScheduler();
  const visibility = new FakeVisibility(true);
  let attempts = 0;
  const controller = new ActivityHeartbeatController({
    scheduler,
    visibility,
    send: async () => { attempts += 1; },
  });

  controller.start();
  assert.equal(attempts, 1);
  assert.equal(scheduler.pendingCount, 1);
  await flushMicrotasks();
  scheduler.advanceBy(59_999);
  assert.equal(attempts, 1);
  scheduler.advanceBy(1);
  assert.equal(attempts, 2);
  await flushMicrotasks();
  scheduler.advanceBy(60_000);
  assert.equal(attempts, 3);
});

test("hidden controller waits; hide aborts and clears; resume attempts immediately with fresh timing", async () => {
  const scheduler = new FakeScheduler();
  const visibility = new FakeVisibility(false);
  const signals: AbortSignal[] = [];
  const firstVisibleRequest = deferred();
  const controller = new ActivityHeartbeatController({
    scheduler,
    visibility,
    send: (signal) => {
      signals.push(signal);
      return signals.length === 1 ? firstVisibleRequest.promise : Promise.resolve();
    },
  });

  controller.start();
  assert.equal(signals.length, 0);
  assert.equal(scheduler.pendingCount, 0);

  visibility.setVisible(true);
  assert.equal(signals.length, 1);
  assert.equal(scheduler.pendingCount, 1);
  visibility.setVisible(false);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(scheduler.pendingCount, 0);

  visibility.setVisible(true);
  assert.equal(signals.length, 2);
  await flushMicrotasks();
  scheduler.advanceBy(59_999);
  assert.equal(signals.length, 2);
  scheduler.advanceBy(1);
  assert.equal(signals.length, 3);
  firstVisibleRequest.resolve();
  await flushMicrotasks();
});

test("single-flight suppresses overlap and allows a later cycle after settlement", async () => {
  const scheduler = new FakeScheduler();
  const visibility = new FakeVisibility(true);
  const first = deferred();
  let attempts = 0;
  const controller = new ActivityHeartbeatController({
    scheduler,
    visibility,
    send: () => {
      attempts += 1;
      return attempts === 1 ? first.promise : Promise.resolve();
    },
  });

  controller.start();
  scheduler.advanceBy(60_000);
  assert.equal(attempts, 1);
  first.resolve();
  await flushMicrotasks();
  scheduler.advanceBy(60_000);
  assert.equal(attempts, 2);
});

test("temporary failure is swallowed and retried only on the next eligible cycle", async () => {
  const scheduler = new FakeScheduler();
  const visibility = new FakeVisibility(true);
  let attempts = 0;
  const controller = new ActivityHeartbeatController({
    scheduler,
    visibility,
    send: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
    },
  });

  controller.start();
  await flushMicrotasks();
  assert.equal(attempts, 1);
  scheduler.advanceBy(59_999);
  assert.equal(attempts, 1);
  scheduler.advanceBy(1);
  assert.equal(attempts, 2);
});

test("identity replacement and unmount abort old work, detach listeners, and prevent old scheduling", async () => {
  const oldScheduler = new FakeScheduler();
  const oldVisibility = new FakeVisibility(true);
  const oldRequest = deferred();
  const oldSignals: AbortSignal[] = [];
  let oldAttempts = 0;
  const oldController = new ActivityHeartbeatController({
    scheduler: oldScheduler,
    visibility: oldVisibility,
    send: (signal) => {
      oldAttempts += 1;
      oldSignals.push(signal);
      return oldRequest.promise;
    },
  });

  oldController.start();
  oldController.stop();
  assert.equal(oldSignals[0]?.aborted, true);
  assert.equal(oldVisibility.listenerCount, 0);
  assert.equal(oldScheduler.pendingCount, 0);

  const newScheduler = new FakeScheduler();
  const newVisibility = new FakeVisibility(true);
  let newAttempts = 0;
  const newController = new ActivityHeartbeatController({
    scheduler: newScheduler,
    visibility: newVisibility,
    send: async () => { newAttempts += 1; },
  });
  newController.start();
  assert.equal(newAttempts, 1);

  oldRequest.resolve();
  await flushMicrotasks();
  oldVisibility.setVisible(false);
  oldVisibility.setVisible(true);
  oldScheduler.advanceBy(180_000);
  assert.equal(oldAttempts, 1);

  newController.stop();
  newScheduler.advanceBy(180_000);
  assert.equal(newAttempts, 1);
  assert.equal(newVisibility.listenerCount, 0);
  assert.equal(newScheduler.pendingCount, 0);
});

test("AuthSessionGate keys the heartbeat mount only to authenticated sessionIdentity", async () => {
  const source = await readFile(new URL("../../app/auth-session-gate.tsx", import.meta.url), "utf8");
  assert.match(source, /state\.status === "authenticated"[\s\S]*?<AuthenticatedActivityHeartbeat sessionIdentity=\{state\.sessionIdentity\}/);
  assert.match(source, /useEffect\(\(\) => \{[\s\S]*?controller\.start\(\)[\s\S]*?controller\.stop\(\)[\s\S]*?\}, \[sessionIdentity\]\)/);
  assert.doesNotMatch(source, /AuthenticatedActivityHeartbeat[^\n]*user\.id|AuthenticatedActivityHeartbeat[^\n]*organizationId/);
});
