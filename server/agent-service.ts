import type { FastifyListenOptions, FastifyServerOptions } from "fastify";

import { buildAgentApp } from "./app";
import {
  loadAgentDatabaseConfig,
  loadAnalysisExecutionContext,
  resolveVocPositioningRuntimeConfig,
} from "./config";
import {
  openSqliteAgentRepository,
  type SqliteAgentRepository,
} from "./db/sqlite-repository";
import type { OpenAiRuntimeCapability } from "./routes/capabilities";
import type { ModelProvider } from "./runtime/model-provider";
import { LocalVocFakeProvider } from "./runtime/local-voc-fake-provider";
import type { ModelValidationLogger } from "./runtime/skill-runner";
import type { WorkerClock, WorkerLogger } from "./runtime/worker-loop";
import {
  createVocPositioningRuntime,
  type VocPositioningRuntime,
} from "./runtime/voc-positioning-runtime";

type AgentEnvironment = Readonly<Record<string, string | undefined>>;

export interface CreateAgentServiceOptions {
  env?: AgentEnvironment;
  repository?: SqliteAgentRepository;
  provider?: ModelProvider;
  providerName?: string;
  skillsRoot?: string;
  logger?: FastifyServerOptions["logger"];
  clock?: () => Date;
  workerClock?: WorkerClock;
  workerLogger?: WorkerLogger;
  validationLogger?: ModelValidationLogger;
}

export interface AgentService {
  readonly app: ReturnType<typeof buildAgentApp>;
  start(options: FastifyListenOptions): Promise<void>;
  stop(): Promise<void>;
}

const INITIALIZATION_FAILED_REASON =
  "VOC positioning runtime initialization failed";

export async function createAgentService(
  options: CreateAgentServiceOptions = {},
): Promise<AgentService> {
  const env = options.env ?? process.env;
  const runtimeEnv =
    env.AGENT_VOC_LOCAL_FAKE === "1" && !env.OPENAI_API_KEY?.trim()
      ? { ...env, OPENAI_API_KEY: "local-fake" }
      : env;
  const ownsRepository = options.repository === undefined;
  const repository =
    options.repository ?? openSqliteAgentRepository(loadAgentDatabaseConfig(env));
  const resolution = resolveVocPositioningRuntimeConfig(runtimeEnv);
  const openaiCapability: OpenAiRuntimeCapability =
    resolution.status === "configured"
      ? {
          configured: true,
          available: false,
          reason: "OpenAI runtime is not active",
        }
      : {
          configured: resolution.status === "invalid",
          available: false,
          reason: resolution.reason,
        };
  const executionContext = loadAnalysisExecutionContext(env);
  const app = buildAgentApp({
    env,
    logger: options.logger,
    storageAvailable: true,
    openaiCapability,
    repository,
    ...(executionContext ? { executionContext } : {}),
  });
  let runtime: VocPositioningRuntime | null = null;
  let started = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;

  const closeOwnedRepository = () => {
    if (ownsRepository) repository.close();
  };

  return Object.freeze({
    app,
    async start(listenOptions: FastifyListenOptions) {
      if (started || stopped) {
        throw new Error("Agent Service can only be started once");
      }
      started = true;
      try {
        await app.listen(listenOptions);
      } catch (error) {
        closeOwnedRepository();
        throw error;
      }
      if (resolution.status !== "configured") {
        app.log.warn(
          { vocRuntimeStatus: resolution.status },
          "VOC positioning runtime is unavailable",
        );
        return;
      }
      try {
        runtime = await createVocPositioningRuntime({
          repository,
          config: resolution.config,
          ...(options.provider
            ? { provider: options.provider }
            : env.AGENT_VOC_LOCAL_FAKE === "1"
              ? { provider: new LocalVocFakeProvider() }
              : {}),
          ...(options.providerName
            ? { providerName: options.providerName }
            : env.AGENT_VOC_LOCAL_FAKE === "1"
              ? { providerName: "local-fixture" }
              : {}),
          ...(options.skillsRoot ? { skillsRoot: options.skillsRoot } : {}),
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.workerClock ? { workerClock: options.workerClock } : {}),
          ...(options.workerLogger ? { logger: options.workerLogger } : {}),
          validationLogger: options.validationLogger ??
            ((entry) => app.log.warn(entry, entry.event)),
        });
        runtime.start();
        openaiCapability.available = true;
        openaiCapability.reason = null;
      } catch {
        runtime = null;
        openaiCapability.available = false;
        openaiCapability.reason = INITIALIZATION_FAILED_REASON;
        app.log.error(
          { vocRuntimeStatus: "initialization-failed" },
          "VOC positioning runtime failed to initialize",
        );
      }
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      stopPromise = (async () => {
        try {
          await runtime?.stop();
          await app.close();
        } finally {
          closeOwnedRepository();
        }
      })();
      return stopPromise;
    },
  });
}
