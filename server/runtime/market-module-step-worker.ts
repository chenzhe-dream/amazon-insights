import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {MarketOverviewEvidenceError} from '../domain/market-research/overview-catalog-compatibility';
import { MARKET_STEP_KINDS, type MarketStepKind, type MarketStepClaim, type MarketStepSettlement,
  type MarketModuleExecutionRepository } from '../db/market-module-execution-repository';
import { createTrustedExecutionAbortReason } from './execution-abort';

type GeneralStepKind = Exclude<MarketStepKind, 'model-batch'>;
export type MarketStepWork = { kind: 'settlement'; value: Omit<MarketStepSettlement, 'claim'> }
  | { kind: 'atomic'; commit(): Promise<unknown> };
export type MarketStepHandler = (input: { claim: MarketStepClaim; signal: AbortSignal }) => Promise<MarketStepWork>;
export interface MarketModuleStepWorkerOptions {
  ownerId?: string; pollMs?: number; leaseMs?: number; heartbeatMs?: number; commitLeaseMs?: number; workTimeoutMs?: number; stopTimeoutMs?: number;
  onEvent?: (event: Readonly<{ event: 'succeeded' | 'empty' | 'failed' | 'lease-lost' | 'poll-failed'; stepId?: string; attemptId?: string; moduleRunId?: string }>) => void;
}
interface Dependencies extends MarketModuleStepWorkerOptions {
  steps: MarketModuleExecutionRepository; handlers: Partial<Record<GeneralStepKind, MarketStepHandler>>;
  moduleKindsByStepKind?: Parameters<MarketModuleExecutionRepository['claimStep']>[0]['moduleKindsByStepKind'];
  flowVersionsByStepKind?: Parameters<MarketModuleExecutionRepository['claimStep']>[0]['flowVersionsByStepKind'];
}
/** Computes outside transactions, drains the computation heartbeat, then commits.
 * Atomic handlers return a deferred commit; late computations never execute it.
 * Model execution retains its separate audited consumer and retry rules. */
export class MarketModuleStepWorker {
  readonly #owner: string; readonly #pollMs: number; readonly #leaseMs: number; readonly #heartbeatMs: number;
  readonly #workTimeoutMs: number; readonly #stopTimeoutMs: number; readonly #handlers: Readonly<Dependencies['handlers']>;
  readonly #commitLeaseMs: number;
  readonly #kinds: GeneralStepKind[];
  #timer: ReturnType<typeof setInterval> | undefined; #running: Promise<boolean> | undefined;
  #controller: AbortController | undefined; #stopped = false; #stopping: Promise<void> | undefined;
  constructor(private readonly deps: Dependencies) {
    this.#owner = z.string().uuid().parse(deps.ownerId ?? randomUUID());
    this.#pollMs = z.number().int().min(25).max(60000).parse(deps.pollMs ?? 1000);
    this.#leaseMs = z.number().int().min(300).max(120000).parse(deps.leaseMs ?? 30000);
    this.#heartbeatMs = z.number().int().min(25).max(this.#leaseMs / 3).parse(deps.heartbeatMs ?? 5000);
    this.#commitLeaseMs = z.number().int().min(300).max(120000).parse(deps.commitLeaseMs ?? 120000);
    this.#workTimeoutMs = z.number().int().min(100).max(300000).parse(deps.workTimeoutMs ?? 120000);
    this.#stopTimeoutMs = z.number().int().min(100).max(60000).parse(deps.stopTimeoutMs ?? 10000);
    const keys = Object.keys(deps.handlers);
    if (!keys.length || keys.some(k => k === 'model-batch' || !MARKET_STEP_KINDS.includes(k as MarketStepKind) || typeof deps.handlers[k as GeneralStepKind] !== 'function')) throw new TypeError('Market step handlers must be registered non-model kinds');
    this.#handlers = Object.freeze({ ...deps.handlers }); this.#kinds = keys as GeneralStepKind[];
  }
  start() {
    if (this.#stopped) throw new Error('A stopped market step worker cannot be restarted');
    if (this.#timer) return;
    const poll = () => { void this.tick().catch(() => this.#emit({ event: 'poll-failed' })); };
    this.#timer = setInterval(poll, this.#pollMs); this.#timer.unref(); poll();
  }
  tick(): Promise<boolean> {
    if (this.#running) return this.#running;
    if (this.#stopped) return Promise.resolve(false);
    this.#running = this.#run().finally(() => { this.#running = undefined; this.#controller = undefined; }); return this.#running;
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopped = true; if (this.#timer) clearInterval(this.#timer); this.#timer = undefined;
    this.#controller?.abort(createTrustedExecutionAbortReason('worker-stopping'));
    this.#stopping = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.#running, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Market step worker did not drain before the stop deadline')), this.#stopTimeoutMs); })]); }
      finally { if (timer) clearTimeout(timer); }
    })(); return this.#stopping;
  }
  async #run(): Promise<boolean> {
    const controller = new AbortController(); this.#controller = controller;
    const claim = await this.deps.steps.claimStep({ leaseOwnerId: this.#owner, leaseMs: this.#leaseMs, kinds: this.#kinds,
      ...(this.deps.moduleKindsByStepKind ? { moduleKindsByStepKind: this.deps.moduleKindsByStepKind } : {}),
      ...(this.deps.flowVersionsByStepKind ? { flowVersionsByStepKind: this.deps.flowVersionsByStepKind } : {}) });
    if (!claim) return false;
    const identity = { stepId: claim.stepId, attemptId: claim.attemptId, moduleRunId: claim.moduleRunId };
    const deadline = performance.now() + this.#workTimeoutMs;
    let timedOut = false, lost = false, drained = false;
    const workTimer = setTimeout(() => { timedOut = true; controller.abort(new Error('Market step computation timed out')); }, this.#workTimeoutMs);
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined, heartbeat: Promise<void> | undefined;
    const renew = async () => {
      try { if (!await this.deps.steps.renewStep({ claim, leaseMs: this.#leaseMs })) lost = true; } catch { lost = true; }
      if (lost) controller.abort(createTrustedExecutionAbortReason('lease-lost'));
      if (!drained && !controller.signal.aborted) heartbeatTimer = setTimeout(() => { heartbeat = renew(); }, this.#heartbeatMs);
    };
    heartbeatTimer = setTimeout(() => { heartbeat = renew(); }, this.#heartbeatMs);
    const drain = async () => { drained = true; if (heartbeatTimer) clearTimeout(heartbeatTimer); clearTimeout(workTimer); await heartbeat; };
    const ensure = () => { if (performance.now() >= deadline) { timedOut = true; controller.abort(new Error('Market step computation timed out')); } controller.signal.throwIfAborted(); };
    try {
      ensure(); const handler = this.#handlers[claim.step.kind as GeneralStepKind]; if (!handler) throw new Error('Unregistered market step kind');
      const work = await this.#compute(() => handler({ claim, signal: controller.signal }), controller.signal);
      await drain(); ensure();
      // A bounded fresh commit lease replaces the short computation heartbeat.
      // Large atomic batch manifests must not inherit an almost-expired lease.
      if (!await this.deps.steps.renewStep({ claim, leaseMs: this.#commitLeaseMs })) { lost = true; throw new Error('Market step lease lost before commit'); }
      controller.signal.throwIfAborted();
      if (work.kind === 'settlement') {
        const receipt = await this.deps.steps.settleAndEnqueue({ ...work.value, claim });
        if (receipt.status === 'lease-lost') { lost = true; throw new Error('Market step lease lost'); }
      } else if (work.kind === 'atomic') await work.commit();
      else throw new Error('Invalid market step work');
      const status = await this.#terminal(claim);
      if (!status) throw new Error('Market step handler did not persist a terminal attempt');
      this.#emit({ ...identity, event: status });
    } catch (error) {
      await drain();
      if (lost) this.#emit({ ...identity, event: 'lease-lost' });
      else try {
        const completed = await this.#terminal(claim);
        if (completed) this.#emit({ ...identity, event: completed });
        else {
          const code = timedOut ? 'timeout' : controller.signal.aborted ? 'interrupted' : error instanceof z.ZodError || error instanceof MarketOverviewEvidenceError ? 'invalid-data' : 'internal';
          const receipt = await this.deps.steps.settleAndEnqueue({ claim, outcome: { status: 'failed', error: { code, retryable: code === 'timeout' || code === 'interrupted' } } });
          this.#emit({ ...identity, event: receipt.status === 'lease-lost' ? 'lease-lost' : 'failed' });
        }
      } catch { this.#emit({ ...identity, event: 'lease-lost' }); }
    } finally { await drain(); }
    return true;
  }
  async #compute(work: () => Promise<MarketStepWork>, signal: AbortSignal) {
    signal.throwIfAborted(); let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new Error('Market step computation interrupted')); });
    signal.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), interrupted]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  async #terminal(claim: MarketStepClaim): Promise<'succeeded' | 'empty' | 'failed' | null> {
    const view = await this.deps.steps.findModuleRun({ actor: { organizationId: claim.organizationId, userId: claim.createdBy }, moduleRunId: claim.moduleRunId });
    const step = view?.steps.find(s => s.id === claim.stepId), attempt = view?.attempts.find(a => a.id === claim.attemptId);
    if (!step || step.latestAttemptId !== claim.attemptId || !attempt) return null;
    return ['succeeded', 'empty', 'failed'].includes(attempt.status) ? attempt.status as 'succeeded' | 'empty' | 'failed' : null;
  }
  #emit(event: Parameters<NonNullable<MarketModuleStepWorkerOptions['onEvent']>>[0]) { try { this.deps.onEvent?.(Object.freeze(event)); } catch { /* Logging cannot change state. */ } }
}
