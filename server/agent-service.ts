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
import {
  createRemoteMcpConnectors,
} from "./connectors/mcp-connectors";
import type { ConnectorMap } from "./connectors/connector-contract";
import type { ModelProvider } from "./runtime/model-provider";
import { LocalVocFakeProvider } from "./runtime/local-voc-fake-provider";
import type { ModelValidationLogger } from "./runtime/skill-runner";
import type { WorkerClock, WorkerLogger } from "./runtime/worker-loop";
import { OpenAIProvider } from "./runtime/openai-provider";
import { createTrafficAnalysisRuntime } from "./runtime/traffic-analysis-runtime";
import { createProductDefinitionRuntime } from "./runtime/product-definition-runtime";
import {
  createVocPositioningRuntime,
  type VocPositioningRuntime,
} from "./runtime/voc-positioning-runtime";
import { ConnectorProbeService } from "./services/connector-probe-service";

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
  connectors?: ConnectorMap;
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
  const connectors = options.connectors ?? createRemoteMcpConnectors({ env });
  const connectorProbeService = executionContext
    ? new ConnectorProbeService({
        repository,
        organizationId: executionContext.organizationId,
        env,
        connectors,
        ...(options.clock ? { clock: options.clock } : {}),
      })
    : null;
  const app = buildAgentApp({
    env,
    logger: options.logger,
    storageAvailable: true,
    openaiCapability,
    repository,
    ...(executionContext ? { executionContext } : {}),
    connectorProbeService,
  });
  let vocRuntime: VocPositioningRuntime | null = null;
  let trafficRuntime: VocPositioningRuntime | null = null;
  let productRuntime: VocPositioningRuntime | null = null;
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
        const provider = options.provider ??
          (env.AGENT_VOC_LOCAL_FAKE === "1"
            ? new LocalVocFakeProvider()
            : new OpenAIProvider({
                apiKey: resolution.config.apiKey,
                transport: resolution.config.transport,
                baseUrl: resolution.config.baseUrl,
              }));
        const providerName = options.providerName ??
          (env.AGENT_VOC_LOCAL_FAKE === "1"
            ? "local-fixture"
            : resolution.config.providerName);
        vocRuntime = await createVocPositioningRuntime({
          repository,
          config: resolution.config,
          provider,
          providerName,
          ...(options.skillsRoot ? { skillsRoot: options.skillsRoot } : {}),
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.workerClock ? { workerClock: options.workerClock } : {}),
          ...(options.workerLogger ? { logger: options.workerLogger } : {}),
          validationLogger: options.validationLogger ??
            ((entry) => app.log.warn(entry, entry.event)),
        });
        trafficRuntime = await createTrafficAnalysisRuntime({
          repository,
          config: { ...resolution.config, providerName },
          provider,
          ...(options.skillsRoot ? { skillsRoot: options.skillsRoot } : {}),
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.workerClock ? { workerClock: options.workerClock } : {}),
          ...(options.workerLogger ? { logger: options.workerLogger } : {}),
        });
        productRuntime = await createProductDefinitionRuntime({
          repository,
          config: resolution.config,
          provider,
          providerName,
          ...(options.skillsRoot ? { skillsRoot: options.skillsRoot } : {}),
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.workerClock ? { workerClock: options.workerClock } : {}),
          ...(options.workerLogger ? { logger: options.workerLogger } : {}),
        });
        vocRuntime.start();
        trafficRuntime.start();
        productRuntime.start();
        openaiCapability.available = true;
        openaiCapability.reason = null;
      } catch {
        await Promise.allSettled([vocRuntime?.stop(), trafficRuntime?.stop(), productRuntime?.stop()]);
        vocRuntime = null;
        trafficRuntime = null;
        productRuntime = null;
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
          await Promise.all([vocRuntime?.stop(), trafficRuntime?.stop(), productRuntime?.stop()]);
          await app.close();
        } finally {
          closeOwnedRepository();
        }
      })();
      return stopPromise;
    },
  });
}
