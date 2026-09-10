import { z } from 'zod';
import type { RuntimeAgentRepository } from '../db/repository';
import type { RemoteMcpConnector } from '../connectors/connector-contract';
import type { TrafficListingCollection } from '../../shared/traffic-listing-contract';
import { collectTrafficListing } from './traffic-listing-collection';

export class TrafficDetailRecoveryError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
export class TrafficDetailRecoveryService {
  readonly #options: { repository: RuntimeAgentRepository; connector: RemoteMcpConnector; timeoutMs?: number };
  readonly #pending = new Map<string, { requestId: string; promise: Promise<TrafficListingCollection> }>();
  constructor(options: { repository: RuntimeAgentRepository; connector: RemoteMcpConnector; timeoutMs?: number }) { this.#options = options; }
  async recover(input: { actorId: string; organizationId: string; runId: string; requestId: string }): Promise<TrafficListingCollection> {
    for (const id of Object.values(input)) z.uuid().parse(id);
    const repository = this.#options.repository, store = repository.trafficDetailRecoveries;
    if (!store) throw new TrafficDetailRecoveryError(503, '当前存储不支持流量明细补采');
    const [actor, run] = await Promise.all([repository.findUserById(input.actorId), repository.findAnalysisRun(input.runId)]);
    const project = run ? await repository.findProjectById(run.projectId) : null;
    if (!actor || actor.status !== 'active' || actor.organizationId !== input.organizationId || !project || project.organizationId !== input.organizationId || project.marketplace !== 'US') throw new TrafficDetailRecoveryError(404, 'Traffic scope not found');
    const prior = await store.findById({ organizationId: input.organizationId, runId: input.runId, id: input.requestId });
    if (prior) return prior.collection;
    const key = `${input.organizationId}:${input.runId}`;
    const pending = this.#pending.get(key);
    if (pending) {
      if (pending.requestId !== input.requestId) throw new TrafficDetailRecoveryError(409, '该项目正在补采流量明细，请等待当前请求完成');
      return pending.promise;
    }
    const operation = (async () => {
      const base = (await repository.listTrafficDataSnapshotsByRun({ actorOrganizationId: input.organizationId, runId: input.runId })).at(-1);
      if (!base) throw new TrafficDetailRecoveryError(404, 'Traffic scope not found');
      const timeoutMs = this.#options.timeoutMs ?? 45_000;
      const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const captured = await collectTrafficListing({ connector: this.#options.connector, organizationId: input.organizationId, runId: input.runId, asins: project.asins, marketplace: 'US', id: input.requestId, signal });
        signal.throwIfAborted();
        const saved = await store.append({ actorId: input.actorId, actorOrganizationId: input.organizationId, runId: input.runId, expectedProjectId: project.id, expectedMarketplace: 'US', expectedAsins: project.asins, expectedRunCutoffAt: run!.dataCutoffAt, baseSnapshotId: base.id, deadlineAt, ...captured });
        return saved.collection;
      } catch (error) {
        if (error instanceof TrafficDetailRecoveryError) throw error;
        throw new TrafficDetailRecoveryError(503, signal.aborted ? '流量明细补采超时，已保留原结果，可重新补采' : '流量明细补采失败，已保留原结果，请检查数据源后重试');
      }
    })();
    this.#pending.set(key, { requestId: input.requestId, promise: operation });
    try { return await operation; } finally { if (this.#pending.get(key)?.promise === operation) this.#pending.delete(key); }
  }
}
