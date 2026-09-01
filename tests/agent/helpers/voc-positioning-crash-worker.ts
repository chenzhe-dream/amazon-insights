import { randomUUID } from "node:crypto";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { openSqliteAgentRepository } from "../../../server/db/sqlite-repository";
import { AuditedSkillRunner } from "../../../server/runtime/agent-run-service";
import {
  ModelBudgetCoordinator,
  StaticModelBudgetLimitProvider,
} from "../../../server/runtime/model-budget-coordinator";
import {
  ModelProviderError,
  type ModelProvider,
} from "../../../server/runtime/model-provider";
import { SkillRunner } from "../../../server/runtime/skill-runner";
import { JobAttemptWorkerLoop } from "../../../server/runtime/worker-loop";
import { SkillRegistry } from "../../../server/skills/registry";
import { VocPositioningExecutionService } from "../../../server/services/voc-positioning-execution-service";
import { createVocPositioningJobHandler } from "../../../server/services/voc-positioning-worker-handler";
import type { VocDeterministicPreprocessingResult } from "../../../server/domain/voc/preprocess-voc-snapshot";
import { validAmazonVocInsightOutput } from "./voc-positioning-fixture";

const data = workerData as {
  path: string;
  crashPoint:
    | "before-report"
    | "after-report"
    | "after-terminal-failure-before-fail-job"
    | "graceful-after-terminal-failure-before-fail-job"
    | "heartbeat-after-terminal-failure-before-fail-job";
  subject: {
    actorId: string;
    organizationId: string;
    projectId: string;
    snapshotId: string;
    facts: VocDeterministicPreprocessingResult;
  };
};
const repository = openSqliteAgentRepository({
  path: data.path,
  busyTimeoutMs: 5_000,
  nowProvider: () => new Date("2026-08-16T00:00:03.000Z"),
});

parentPort?.ref();
void main();

async function main() {
try {
  const provider: ModelProvider = {
    async generateStructured<T>() {
      parentPort?.postMessage({ type: "provider-call" });
      if (data.crashPoint.includes("terminal-failure")) {
        throw new ModelProviderError("transient", "private crash probe");
      }
      return {
        value: validAmazonVocInsightOutput(data.subject.facts) as T,
        responseId: "crash-worker-response",
        inputTokens: 500,
        outputTokens: 250,
      };
    },
  };
  const registry = await SkillRegistry.open(path.resolve("skills-src"));
  let tick = Date.parse("2026-08-16T00:00:02.000Z");
  const clock = () => new Date((tick += 10));
  const skillRunner = new SkillRunner({
    registry,
    provider,
    providerName: "fake",
    budgetCoordinator: new ModelBudgetCoordinator({
      repository,
      limitProvider: new StaticModelBudgetLimitProvider({
        call: { maxTokens: 50_000, maxCostMicros: 50_000 },
        run: { maxTokens: 50_000, maxCostMicros: 50_000 },
        organizationUtcDay: { maxTokens: 50_000, maxCostMicros: 50_000 },
      }),
      clock,
      createId: randomUUID,
    }),
    sleep: async () => {},
    now: () => tick,
  });
  let terminalFailurePersisted = false;
  const auditedRepository =
    data.crashPoint === "heartbeat-after-terminal-failure-before-fail-job"
      ? new Proxy(repository, {
          get(target, property) {
            if (property === "finalizeAgentRun") {
              return async (
                ...args: Parameters<
                  typeof repository.finalizeAgentRun
                >
              ) => {
                const result = await target.finalizeAgentRun(...args);
                terminalFailurePersisted = true;
                parentPort?.postMessage({ type: "terminal-failure-persisted" });
                await new Promise<never>(() => undefined);
                return result;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : repository;
  const auditedRunner = new AuditedSkillRunner({
    skillRunner,
    repository: auditedRepository,
    clock,
    createId: randomUUID,
  });
  const serviceRepository =
    data.crashPoint === "before-report"
      ? new Proxy(repository, {
          get(target, property) {
            if (property === "publishVocPositioningReport") {
              return async () => {
                parentPort?.postMessage({ type: "crash-ready" });
                await new Promise<never>(() => undefined);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : repository;
  const service = new VocPositioningExecutionService({
    repository: serviceRepository,
    auditedRunner,
    clock,
    createId: randomUUID,
  });
  const productionHandler = createVocPositioningJobHandler({
    service,
    prepare: () => ({
      request: {
        snapshotId: data.subject.snapshotId,
        facts: data.subject.facts,
        model: {
          name: "configured-test-model",
          estimatedInputTokens: 4_000,
          maxOutputTokens: 4_000,
          timeoutMs: 5_000,
          pricing: {
            inputUsdPerMillionTokens: 1,
            outputUsdPerMillionTokens: 2,
          },
        },
      },
      context: {
        actorId: data.subject.actorId,
        organizationId: data.subject.organizationId,
        projectId: data.subject.projectId,
        dataCutoffAt: "2026-08-15T23:59:59.999Z",
      },
    }),
  });
  const handler =
    data.crashPoint === "after-report"
      ? async (context: Parameters<typeof productionHandler>[0]) => {
          await productionHandler(context);
          parentPort?.postMessage({ type: "crash-ready" });
          await new Promise<never>(() => undefined);
        }
      : productionHandler;
  const workerHolder: { current?: JobAttemptWorkerLoop } = {};
  const workerRepository = data.crashPoint.includes("terminal-failure")
    ? new Proxy(repository, {
        get(target, property) {
          if (
            property === "renewJobLease" &&
            data.crashPoint ===
              "heartbeat-after-terminal-failure-before-fail-job" &&
            terminalFailurePersisted
          ) {
            return async () => {
              parentPort?.postMessage({ type: "crash-ready" });
              throw new Error("simulated heartbeat lease loss");
            };
          }
          if (property === "failJob") {
            return async () => {
              parentPort?.postMessage({ type: "crash-ready" });
              if (
                data.crashPoint ===
                "graceful-after-terminal-failure-before-fail-job"
              ) {
                void workerHolder.current?.stop().then(() => {
                  parentPort?.postMessage({ type: "graceful-stopped" });
                });
              }
              await new Promise<never>(() => undefined);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : repository;
  const worker = new JobAttemptWorkerLoop({
    repository: workerRepository,
    ownerId: "isolated-crash-worker",
    handler,
    leaseDurationMs: 120_000,
    heartbeatIntervalMs:
      data.crashPoint ===
      "heartbeat-after-terminal-failure-before-fail-job"
        ? 5
        : 60_000,
    pollIntervalMs: 100,
    stopTimeoutMs: 50,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    },
    clock: {
      now: () => "2026-08-16T00:00:02.000Z",
      sleep: async (durationMs, signal) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, durationMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    },
  });
  workerHolder.current = worker;
  await worker.runOnce();
} catch (error) {
  parentPort?.postMessage({
    type: "error",
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : "Unknown worker error",
  });
  repository.close();
}
}
