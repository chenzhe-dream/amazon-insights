import type { TrafficDataSnapshotRecord } from "../data/traffic-data-snapshot";
import type { RuntimeAgentRepository } from "../db/repository";
import { SifTrafficSnapshotTask } from "./sif-traffic-snapshot-task";

export class UnauthorizedScopedTrafficSnapshotError extends Error {
  constructor() {
    super("Authorized sync scope is unavailable");
    this.name = "UnauthorizedScopedTrafficSnapshotError";
  }
}

function sameAsinScope(left: readonly string[], right: readonly string[]) {
  return [...left].sort().join(",") === [...right].sort().join(",");
}

export class ScopedSifTrafficSnapshotAdapter {
  readonly #repository: RuntimeAgentRepository;
  readonly #task: SifTrafficSnapshotTask;

  constructor(options: { repository: RuntimeAgentRepository; task: SifTrafficSnapshotTask }) {
    this.#repository = options.repository;
    this.#task = options.task;
  }

  async createForAuthorizedRun(input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    runId: string;
    marketplace: "US";
    asins: readonly string[];
  }): Promise<{ snapshot: TrafficDataSnapshotRecord; reused: boolean }> {
    const [actor, run] = await Promise.all([
      this.#repository.findUserById(input.actorId),
      this.#repository.findAnalysisRun(input.runId),
    ]);
    if (!actor || actor.status !== "active" || actor.organizationId !== input.organizationId || !run || run.projectId !== input.projectId) {
      throw new UnauthorizedScopedTrafficSnapshotError();
    }
    const project = await this.#repository.findProjectById(run.projectId);
    if (
      !project ||
      project.organizationId !== input.organizationId ||
      project.marketplace !== input.marketplace ||
      !sameAsinScope(project.asins, input.asins)
    ) {
      throw new UnauthorizedScopedTrafficSnapshotError();
    }
    const existing = await this.#repository.listTrafficDataSnapshotsByRun({
      actorOrganizationId: input.organizationId,
      runId: run.id,
    });
    const snapshot = await this.#task.createForRun({
      actorId: actor.id,
      organizationId: actor.organizationId,
      projectId: project.id,
      runId: run.id,
      marketplace: project.marketplace,
      asins: project.asins,
      dataCutoffAt: run.dataCutoffAt,
    });
    return { snapshot, reused: existing.length > 0 };
  }
}
