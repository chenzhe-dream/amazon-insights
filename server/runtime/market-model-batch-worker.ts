import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MarketSemanticTaskNameSchema, type MarketSemanticTaskName } from '../../shared/market-semantic-contracts';
import type { MarketAgentRunRepository } from '../db/market-agent-run-repository';
import type { MarketModuleExecutionRepository, MarketModuleRun, MarketStepClaim } from '../db/market-module-execution-repository';
import type { MarketSemanticExecutionService, ResolvedMarketSemanticConfiguration } from './market-semantic-execution-service';
import { createTrustedExecutionAbortReason } from './execution-abort';

export interface MarketModelWorkerEvent {
  event: 'succeeded' | 'failed' | 'cancelled' | 'observing' | 'preparation-failed' | 'persistence-failed' | 'poll-failed';
  moduleRunId?: string; stepId?: string; attemptId?: string;
}
export interface MarketModelWorkerOptions {
  ownerId?: string; pollMs?: number; leaseMs?: number; heartbeatMs?: number; stopTimeoutMs?: number;
  moduleKindsByStepKind?: Parameters<MarketModuleExecutionRepository['claimStep']>[0]['moduleKindsByStepKind'];
  flowVersionsByStepKind?: Parameters<MarketModuleExecutionRepository['claimStep']>[0]['flowVersionsByStepKind'];
  onEvent?: (event: Readonly<MarketModelWorkerEvent>) => void;
}
export class MarketModelConfigurationUnavailableError extends Error {
  constructor() { super('Market model configuration is unavailable'); this.name = 'MarketModelConfigurationUnavailableError'; }
}
interface Dependencies extends MarketModelWorkerOptions {
  steps: MarketModuleExecutionRepository;
  audit: MarketAgentRunRepository;
  execution: Pick<MarketSemanticExecutionService, 'executeBatch'>;
  resolveConfiguration: (input: { task: MarketSemanticTaskName; run: MarketModuleRun }) => ResolvedMarketSemanticConfiguration | Promise<ResolvedMarketSemanticConfiguration>;
}

/** A single-slot consumer of the persisted model-batch queue. The semantic service
 * owns model retries, audit claims and completion; this worker never retries it.
 */
export class MarketModelBatchWorker {
  readonly #owner: string;
  readonly #pollMs: number;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #stopTimeoutMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<boolean> | undefined;
  #controller: AbortController | undefined;
  #stopped = false;
  #stopPromise: Promise<void> | undefined;
  constructor(private readonly deps: Dependencies) {
    this.#owner = z.string().uuid().parse(deps.ownerId ?? randomUUID());
    this.#pollMs = z.number().int().min(25).max(60000).parse(deps.pollMs ?? 1000);
    this.#leaseMs = z.number().int().min(300).max(120000).parse(deps.leaseMs ?? 30000);
    this.#heartbeatMs = z.number().int().min(25).max(this.#leaseMs / 3).parse(deps.heartbeatMs ?? 5000);
    this.#stopTimeoutMs = z.number().int().min(100).max(60000).parse(deps.stopTimeoutMs ?? 10000);
  }
  start(): void {
    if (this.#stopped) throw new Error('A stopped market worker cannot be restarted');
    if (this.#timer) return;
    const poll = () => { void this.tick().catch(() => this.#emit({ event: 'poll-failed' })); };
    this.#timer = setInterval(poll, this.#pollMs); this.#timer.unref(); poll();
  }
  tick(): Promise<boolean> {
    if (this.#running) return this.#running;
    if (this.#stopped) return Promise.resolve(false);
    this.#running = this.#run().finally(() => { this.#running = undefined; this.#controller = undefined; });
    return this.#running;
  }
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true; if (this.#timer) clearInterval(this.#timer); this.#timer = undefined;
    this.#controller?.abort(createTrustedExecutionAbortReason('worker-stopping'));
    this.#stopPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.#running, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Market worker did not drain before the stop deadline')), this.#stopTimeoutMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    })();
    return this.#stopPromise;
  }
  async #run(): Promise<boolean> {
    const controller = new AbortController(); this.#controller = controller;
    const claim = await this.deps.steps.claimStep({ leaseOwnerId: this.#owner, leaseMs: this.#leaseMs, kinds: ['model-batch'],
      ...(this.deps.moduleKindsByStepKind ? { moduleKindsByStepKind: this.deps.moduleKindsByStepKind } : {}),
      ...(this.deps.flowVersionsByStepKind ? { flowVersionsByStepKind: this.deps.flowVersionsByStepKind } : {}) });
    if (!claim) return false;
    const identity = { moduleRunId: claim.moduleRunId, stepId: claim.stepId, attemptId: claim.attemptId };
    let preparationDone = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: Promise<void> | undefined;
    const renew = async () => {
      try { if (!await this.deps.steps.renewStep({ claim, leaseMs: this.#leaseMs })) controller.abort(createTrustedExecutionAbortReason('lease-lost')); }
      catch { controller.abort(createTrustedExecutionAbortReason('lease-lost')); }
      if (!preparationDone && !controller.signal.aborted) heartbeatTimer = setTimeout(() => { heartbeat = renew(); }, this.#heartbeatMs);
    };
    const endPreparation = async () => { preparationDone = true; if (heartbeatTimer) clearTimeout(heartbeatTimer); await heartbeat; };
    heartbeatTimer = setTimeout(() => { heartbeat = renew(); }, this.#heartbeatMs);
    try {
      controller.signal.throwIfAborted();
      const view = await this.deps.steps.findModuleRun({ actor: { organizationId: claim.organizationId, userId: claim.createdBy }, moduleRunId: claim.moduleRunId });
      if (!view || view.run.scope.researchId !== claim.studyId || view.run.createdBy !== claim.createdBy) throw new Error('Market run is unavailable');
      const task = MarketSemanticTaskNameSchema.parse((claim.step.input as { task?: unknown })?.task);
      const configuration = await this.#prepareConfiguration({ task, run: view.run }, controller.signal);
      await endPreparation(); // Transfer lease maintenance to executeBatch; no competing completion heartbeat.
      controller.signal.throwIfAborted();
      const result = await this.deps.execution.executeBatch(claim, configuration, controller.signal);
      this.#emit({ ...identity, event: result.agentRun.terminalStatus==='cancelled'?'cancelled':result.status });
    } catch (error) {
      await endPreparation();
      await this.#handleFailure(claim, controller.signal, error);
    } finally { await endPreparation(); }
    return true;
  }
  async #prepareConfiguration(input: { task: MarketSemanticTaskName; run: MarketModuleRun }, signal: AbortSignal) {
    signal.throwIfAborted();
    let abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Market worker preparation interrupted')); });
    signal.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([this.deps.resolveConfiguration(input), interrupted]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  async #handleFailure(claim: MarketStepClaim, signal: AbortSignal, failure: unknown) {
    const identity = { moduleRunId: claim.moduleRunId, stepId: claim.stepId, attemptId: claim.attemptId };
    try {
      const records = await this.deps.audit.listAgentRuns({ actor: { organizationId: claim.organizationId, userId: claim.createdBy }, studyId: claim.studyId, moduleRunId: claim.moduleRunId });
      const cancelled=records.find(r=>r.attemptId===claim.attemptId)?.terminalStatus==='cancelled';
      const view=await this.deps.steps.findModuleRun({actor:{organizationId:claim.organizationId,userId:claim.createdBy},moduleRunId:claim.moduleRunId});
      if(view?.run.status==='cancelled'&&(cancelled||!records.some(r=>r.attemptId===claim.attemptId))){this.#emit({...identity,event:'cancelled'});return;}
      if (records.some(r => r.attemptId === claim.attemptId)) {
        // A model/audit may already exist. Do not overwrite it or enqueue an outer retry.
        this.#emit({ ...identity, event: 'persistence-failed' }); return;
      }
      const unavailable = failure instanceof MarketModelConfigurationUnavailableError;
      const receipt = await this.deps.steps.settleAndEnqueue({ claim,
        outcome: unavailable
          ? { status: 'failed', error: { code: 'governance', retryable: false }, diagnostic: { reason: 'model-configuration-unavailable' } }
          : { status: 'failed', error: { code: signal.aborted ? 'interrupted' : 'invalid-data', retryable: false } } });
      this.#emit({ ...identity, event: receipt.status === 'lease-lost' ? 'persistence-failed' : 'preparation-failed' });
    } catch { this.#emit({ ...identity, event: 'persistence-failed' }); }
  }
  #emit(event: MarketModelWorkerEvent) { try { this.deps.onEvent?.(Object.freeze(event)); } catch { /* Logging cannot change queue state. */ } }
}
