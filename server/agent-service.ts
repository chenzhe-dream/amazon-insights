import type { FastifyListenOptions, FastifyServerOptions } from "fastify";

import { buildAgentApp } from "./app";
import {
  loadAgentAuthenticationConfig,
  loadResourceGovernorRuntimeConfig,
  loadAgentStorageConfig,
  loadAnalysisExecutionContext,
  resolveVocPositioningRuntimeConfig,
} from "./config";
import { AuthenticationService } from "./auth/authentication-service";
import { BoundedLoginRateLimiter } from "./auth/login-rate-limiter";
import { openRuntimeAgentRepository } from "./db/open-runtime-repository";
import type {
  RuntimeAgentRepository,
  RuntimeAgentRepositoryLifecycle,
} from "./db/repository";
import { PostgresResourceGovernor } from "./db/concurrency-control-repository";
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
import { SyncJobDispatcher } from "./runtime/sync-job-dispatcher";
import { createTrafficAnalysisRuntime } from "./runtime/traffic-analysis-runtime";
import { createProductDefinitionRuntime } from "./runtime/product-definition-runtime";
import {
  createVocPositioningRuntime,
  type VocPositioningRuntime,
} from "./runtime/voc-positioning-runtime";
import { ConnectorProbeService } from "./services/connector-probe-service";
import { ConnectorCredentialService } from "./services/connector-credential-service";
import { createConnectorCredentialCipher } from "./security/connector-credential-cipher";
import { createDefaultLocalDataBridgeDeps } from "./routes/local-data";
import { SifTrafficSnapshotTask } from "./services/sif-traffic-snapshot-task";
import { ScopedSifTrafficSnapshotAdapter } from "./services/scoped-sif-traffic-snapshot-adapter";
import { SyncJobWorkerHandler } from "./services/sync-job-worker-handler";

type AgentEnvironment = Readonly<Record<string, string | undefined>>;

export interface CreateAgentServiceOptions {
  env?: AgentEnvironment;
  repository?: RuntimeAgentRepository;
  provider?: ModelProvider;
  providerName?: string;
  skillsRoot?: string;
  logger?: FastifyServerOptions["logger"];
  clock?: () => Date;
  workerClock?: WorkerClock;
  workerLogger?: WorkerLogger;
  validationLogger?: ModelValidationLogger;
  connectors?: ConnectorMap;
  connectorFetchImpl?: typeof fetch;
}

export interface AgentService {
  readonly app: ReturnType<typeof buildAgentApp>;
  start(options: FastifyListenOptions): Promise<void>;
  stop(): Promise<void>;
}

type StoppableRuntime = Readonly<{ stop(): Promise<void> }>;

export async function stopAgentServiceResources({
  runtimes,
  closeApp,
  closeOwnedRepository,
}: {
  runtimes: readonly (StoppableRuntime | null | undefined)[];
  closeApp: () => Promise<void>;
  closeOwnedRepository: () => Promise<void>;
}): Promise<void> {
  const results = [
    ...(await Promise.allSettled(
      runtimes.flatMap((runtime) => runtime ? [runtime.stop()] : []),
    )),
    await Promise.resolve()
      .then(closeApp)
      .then(
        () => ({ status: "fulfilled" as const, value: undefined }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
    await Promise.resolve()
      .then(closeOwnedRepository)
      .then(
        () => ({ status: "fulfilled" as const, value: undefined }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
    ];
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Agent Service failed to stop cleanly",
    );
  }
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
  const authConfig = loadAgentAuthenticationConfig(env);
  let ownedRepository:
    | (RuntimeAgentRepository & RuntimeAgentRepositoryLifecycle)
    | null = null;
  const repository: RuntimeAgentRepository =
    options.repository ??
    (ownedRepository = await openRuntimeAgentRepository(
      loadAgentStorageConfig(env),
    ));

  let ownedRepositoryClosePromise: Promise<void> | null = null;
  const closeOwnedRepository = async () => {
    if (!ownedRepository) return;
    ownedRepositoryClosePromise ??= Promise.resolve(ownedRepository.close());
    await ownedRepositoryClosePromise;
  };

  try {
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
    const resourceGovernor = repository.concurrencyControl
      ? new PostgresResourceGovernor(
          repository.concurrencyControl,
          loadResourceGovernorRuntimeConfig(env).ownerId,
        )
      : undefined;
    const configuredMasterKey = env.AGENT_CONNECTOR_CREDENTIAL_MASTER_KEY;
    const credentialCipher = configuredMasterKey?.trim()
      ? createConnectorCredentialCipher({ ...env })
      : null;
    const connectorCredentialServiceResolver = (organizationId: string) =>
      new ConnectorCredentialService({
        repository,
        cipher: credentialCipher,
        organizationId,
        env,
        ...(options.clock ? { clock: options.clock } : {}),
      });
    const executionCredentialService = executionContext
      ? connectorCredentialServiceResolver(executionContext.organizationId)
      : null;
    const connectors = options.connectors ?? createRemoteMcpConnectors({
      env,
      ...(options.connectorFetchImpl
        ? { fetchImpl: options.connectorFetchImpl }
        : {}),
      ...(resourceGovernor ? { resourceGovernor } : {}),
      ...(executionCredentialService
        ? {
            resolveCredential: async (connectorId) =>
              (await executionCredentialService.resolve(connectorId)).secret,
          }
        : {}),
    });
    const authLimiter = new BoundedLoginRateLimiter({
      ...authConfig.loginLimiter,
      ...(options.clock ? { now: () => options.clock!().getTime() } : {}),
    });
    const authService = new AuthenticationService({
      repository,
      limiter: authLimiter,
      sessionTtlMs: authConfig.sessionTtlMs,
      ...(options.clock ? { now: options.clock } : {}),
    });
    const connectorProbeService = executionContext
      ? new ConnectorProbeService({
          repository,
          organizationId: executionContext.organizationId,
          credentialService: executionCredentialService!,
          connectors,
          ...(options.clock ? { clock: options.clock } : {}),
        })
      : null;
    const dynamicTrafficSnapshotAdapter = new ScopedSifTrafficSnapshotAdapter({
      repository,
      task: new SifTrafficSnapshotTask({
        repository,
        connector: connectors.sif,
        ...(options.clock ? { clock: options.clock } : {}),
      }),
    });
    const app = buildAgentApp({
      env,
      logger: options.logger,
      storageAvailable: true,
      openaiCapability,
      repository,
      ...(executionContext ? { executionContext } : {}),
      connectorProbeService,
      connectorCredentialServiceResolver,
      authConfig,
      authService,
      localDataBridgeDeps: createDefaultLocalDataBridgeDeps(repository, {
        dynamicTrafficSnapshotAdapter,
      }),
    });
    let vocRuntime: VocPositioningRuntime | null = null;
    let trafficRuntime: VocPositioningRuntime | null = null;
    let productRuntime: VocPositioningRuntime | null = null;
    let syncJobDispatcher: SyncJobDispatcher | null = null;
    let started = false;
    let stopped = false;
    let stopPromise: Promise<void> | null = null;

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
          await closeOwnedRepository();
          throw error;
        }
        syncJobDispatcher = new SyncJobDispatcher({
          syncJobs: repository.syncJobs,
          handler: new SyncJobWorkerHandler({
            syncJobs: repository.syncJobs,
            rootDirectory: process.cwd(),
          }),
        });
        syncJobDispatcher.start();
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
                  ...(resourceGovernor ? { resourceGovernor } : {}),
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
            sifConnector: connectors.sif,
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
          await Promise.allSettled([
            vocRuntime?.stop(),
            trafficRuntime?.stop(),
            productRuntime?.stop(),
          ]);
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
        stopPromise = stopAgentServiceResources({
          runtimes: [syncJobDispatcher, vocRuntime, trafficRuntime, productRuntime],
          closeApp: () => app.close(),
          closeOwnedRepository,
        });
        return stopPromise;
      },
    });
  } catch (error) {
    await closeOwnedRepository();
    throw error;
  }
}
