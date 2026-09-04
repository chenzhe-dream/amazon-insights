import type { FastifyListenOptions, FastifyServerOptions } from "fastify";

import { buildAgentApp, createConcurrencyAdminService } from "./app";
import {
  loadAgentAuthenticationConfig,
  loadDingTalkAuthenticationConfig,
  loadManualAlexaVocPublicationConfig,
  loadManualAlexaVocRetentionConfig,
  loadResourceGovernorRuntimeConfig,
  loadSellerSpriteQuotaRefreshConfig,
  loadAgentStorageConfig,
  loadAnalysisExecutionContext,
  resolveVocPositioningRuntimeConfig,
} from "./config";
import { ManualAlexaVocProjectionStore } from "./data/manual-alexa-voc-projection-store.node.js";
import { AuthenticationService } from "./auth/authentication-service";
import { DingTalkAuthenticationService } from "./auth/dingtalk-authentication-service";
import {
  RemoteDingTalkIdentityProvider,
  type DingTalkIdentityProvider,
} from "./auth/dingtalk-provider";
import { BoundedLoginRateLimiter } from "./auth/login-rate-limiter";
import { openRuntimeAgentRepository } from "./db/open-runtime-repository";
import type {
  DingTalkAuthenticationRepository,
  RuntimeAgentRepository,
  RuntimeAgentRepositoryLifecycle,
} from "./db/repository";
import {
  PostgresResourceGovernor,
  UnavailableConcurrencyControlRepository,
} from "./db/concurrency-control-repository";
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
import {
  createAlexaVocNormalizationRuntime,
  type AlexaVocNormalizationRuntime,
} from "./runtime/alexa-voc-normalization-runtime";
import { ConnectorProbeService } from "./services/connector-probe-service";
import { ConnectorCredentialService } from "./services/connector-credential-service";
import { SyncProviderReadinessService } from "./services/sync-provider-readiness-service";
import { createConnectorCredentialCipher } from "./security/connector-credential-cipher";
import { createManualAlexaVocCipher } from "./security/manual-alexa-voc-cipher";
import {
  createAlexaVocNormalizationInputCipher,
  type AlexaVocNormalizationInputCipher,
} from "./security/alexa-voc-normalization-input-cipher";
import { createDefaultLocalDataBridgeDeps } from "./routes/local-data";
import { SifTrafficSnapshotTask } from "./services/sif-traffic-snapshot-task";
import { ScopedSifTrafficSnapshotAdapter } from "./services/scoped-sif-traffic-snapshot-adapter";
import { SyncJobWorkerHandler } from "./services/sync-job-worker-handler";
import { SellerSpriteQuotaRefreshScheduler } from "./services/seller-sprite-quota-service";
import { ManualAlexaVocPublicationService } from "./services/manual-alexa-voc-publication-service.node.js";
import { ManualAlexaVocRetentionService } from "./services/manual-alexa-voc-retention-service.node.js";

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
  normalizationInputCipher?: AlexaVocNormalizationInputCipher;
  connectors?: ConnectorMap;
  connectorFetchImpl?: typeof fetch;
  dingTalkFetchImpl?: typeof fetch;
  dingTalkProvider?: DingTalkIdentityProvider;
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
  const dingTalkConfig = loadDingTalkAuthenticationConfig(env);
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
    const executionContext = loadAnalysisExecutionContext(env);
    const manualAlexaVocPublicationConfig =
      loadManualAlexaVocPublicationConfig(env);
    const manualAlexaVocPublicationRuntime = manualAlexaVocPublicationConfig
      ? new ManualAlexaVocPublicationService({
          repository: repository.manualAlexaVoc,
          projectionStore: new ManualAlexaVocProjectionStore({
            root: manualAlexaVocPublicationConfig.projectionRoot,
            projectionPathKey:
              manualAlexaVocPublicationConfig.projectionPathKey,
          }),
          ownerId: manualAlexaVocPublicationConfig.ownerId,
          enabled: manualAlexaVocPublicationConfig.enabled,
          leaseDurationMs: manualAlexaVocPublicationConfig.leaseDurationMs,
          pollIntervalMs: manualAlexaVocPublicationConfig.pollIntervalMs,
          reconcileIntervalMs:
            manualAlexaVocPublicationConfig.reconcileIntervalMs,
          retryInitialDelayMs:
            manualAlexaVocPublicationConfig.retryInitialDelayMs,
          retryMaxDelayMs: manualAlexaVocPublicationConfig.retryMaxDelayMs,
          retryMaxAttempts: manualAlexaVocPublicationConfig.retryMaxAttempts,
          ...(options.clock ? { clock: options.clock } : {}),
        })
      : null;
    const manualAlexaVocRetentionConfig =
      loadManualAlexaVocRetentionConfig(env);
    const manualAlexaVocRetentionRuntime = manualAlexaVocRetentionConfig
      ? new ManualAlexaVocRetentionService({
          repository,
          cipher: createManualAlexaVocCipher(env),
          policyByOrganization:
            manualAlexaVocRetentionConfig.policyByOrganization,
          batchSize: manualAlexaVocRetentionConfig.batchSize,
          sweepTargets: Object.keys(
            manualAlexaVocRetentionConfig.policyByOrganization,
          ).map((organizationId) => ({
            organizationId,
            actorUserId: manualAlexaVocRetentionConfig
              .actorUserIdByOrganization[organizationId]!,
          })),
          pollIntervalMs: manualAlexaVocRetentionConfig.pollIntervalMs,
          ...(options.clock ? { clock: options.clock } : {}),
        })
      : null;
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
    const executionOrganizationId = executionContext?.organizationId ?? null;
    const connectors = options.connectors ?? createRemoteMcpConnectors({
      env,
      ...(options.connectorFetchImpl
        ? { fetchImpl: options.connectorFetchImpl }
        : {}),
      ...(resourceGovernor ? { resourceGovernor } : {}),
      ...(executionCredentialService
        ? {
            resolveCredential: async (connectorId, scope) =>
              (await connectorCredentialServiceResolver(
                scope?.organizationId ?? executionOrganizationId!,
              ).resolve(connectorId)).secret,
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
    const dingTalkProvider = dingTalkConfig.enabled
      ? options.dingTalkProvider ?? new RemoteDingTalkIdentityProvider({
          config: dingTalkConfig,
          ...(options.dingTalkFetchImpl
            ? { fetchImpl: options.dingTalkFetchImpl }
            : {}),
        })
      : undefined;
    const dingTalkRepository = hasDingTalkRepository(repository)
      ? repository
      : undefined;
    if (dingTalkConfig.enabled && !dingTalkRepository) {
      throw new Error("DingTalk authentication repository is not configured");
    }
    const dingTalkService = new DingTalkAuthenticationService({
      config: dingTalkConfig,
      ...(dingTalkRepository ? { repository: dingTalkRepository } : {}),
      ...(dingTalkProvider ? { provider: dingTalkProvider } : {}),
      sessionIssuer: authService,
      ...(options.clock ? { now: options.clock } : {}),
    });
    const connectorProbeService = executionContext
        ? new ConnectorProbeService({
            repository,
            organizationId: executionContext.organizationId,
            credentialService: executionCredentialService!,
            credentialServiceResolver: connectorCredentialServiceResolver,
            connectors,
            ...(options.clock ? { clock: options.clock } : {}),
          })
      : null;
    const syncProviderReadiness = new SyncProviderReadinessService({
      credentialServiceResolver: connectorCredentialServiceResolver,
      connectorStatuses: repository,
    });
    const dynamicTrafficSnapshotAdapter = new ScopedSifTrafficSnapshotAdapter({
      repository,
      task: new SifTrafficSnapshotTask({
        repository,
        connector: connectors.sif,
        ...(options.clock ? { clock: options.clock } : {}),
      }),
    });
    const sellerSpriteQuotaRefreshConfig = loadSellerSpriteQuotaRefreshConfig(env);
    const concurrencyAdminService = createConcurrencyAdminService(repository, env);
    const sellerSpriteQuotaScheduler =
      executionContext && sellerSpriteQuotaRefreshConfig && concurrencyAdminService
        ? new SellerSpriteQuotaRefreshScheduler({
            service: concurrencyAdminService,
            organizationId: executionContext.organizationId,
            enabled: true,
            intervalMs: sellerSpriteQuotaRefreshConfig.intervalMs,
          })
        : null;
    const app = buildAgentApp({
      env,
      logger: options.logger,
      storageAvailable: true,
      openaiCapability,
      repository,
      normalizationExecutionIdentity: resolution.status === "configured"
        ? {
            providerName: options.providerName ??
              (env.AGENT_VOC_LOCAL_FAKE === "1" ? "local-fixture" : resolution.config.providerName),
            model: resolution.config.model,
          }
        : null,
      ...(executionContext ? { executionContext } : {}),
      concurrencyAdminService,
      connectorProbeService,
      connectorCredentialServiceResolver,
      authConfig,
      authService,
      dingTalkService,
      localDataBridgeDeps: createDefaultLocalDataBridgeDeps(repository, {
        dynamicTrafficSnapshotAdapter,
        providerReadiness: syncProviderReadiness,
        bypassProviderReadiness: env.AGENT_VOC_LOCAL_FAKE === "1",
        env,
      }),
    });
    let vocRuntime: VocPositioningRuntime | null = null;
    let normalizationRuntime: AlexaVocNormalizationRuntime | null = null;
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
        manualAlexaVocPublicationRuntime?.start();
        manualAlexaVocRetentionRuntime?.start();
        syncJobDispatcher = new SyncJobDispatcher({
          syncJobs: repository.syncJobs,
          concurrencyControl:
            repository.concurrencyControl ??
            new UnavailableConcurrencyControlRepository(),
          handler: new SyncJobWorkerHandler({
            syncJobs: repository.syncJobs,
            connectorStatuses: repository,
            dynamicTrafficSnapshotAdapter,
            rootDirectory: process.cwd(),
            connectorCredentialEnvironment: (organizationId) =>
              connectorCredentialServiceResolver(organizationId).resolveEnvironment(),
          }),
        });
        syncJobDispatcher.start();
        sellerSpriteQuotaScheduler?.start();
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
          try {
            normalizationRuntime = await createAlexaVocNormalizationRuntime({
              repository,
              config: resolution.config,
              provider,
              providerName,
              normalizationInputCipher:
                options.normalizationInputCipher ??
                createAlexaVocNormalizationInputCipher(env),
              ...(options.skillsRoot ? { skillsRoot: options.skillsRoot } : {}),
              ...(options.clock ? { clock: options.clock } : {}),
              ...(options.workerClock ? { workerClock: options.workerClock } : {}),
              ...(options.workerLogger ? { logger: options.workerLogger } : {}),
              validationLogger: options.validationLogger ??
                ((entry) => app.log.warn(entry, entry.event)),
            });
          } catch {
            normalizationRuntime = null;
            app.log.warn(
              { vocRuntimeStatus: "normalization-unavailable" },
              "Alexa VOC normalization runtime is unavailable",
            );
          }
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
          normalizationRuntime?.start();
          vocRuntime.start();
          trafficRuntime.start();
          productRuntime.start();
          openaiCapability.available = true;
          openaiCapability.reason = null;
        } catch {
          await Promise.allSettled([
            vocRuntime?.stop(),
            normalizationRuntime?.stop(),
            trafficRuntime?.stop(),
            productRuntime?.stop(),
          ]);
          vocRuntime = null;
          normalizationRuntime = null;
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
          runtimes: [
            syncJobDispatcher,
            manualAlexaVocPublicationRuntime,
            manualAlexaVocRetentionRuntime,
            vocRuntime,
            normalizationRuntime,
            trafficRuntime,
            productRuntime,
            sellerSpriteQuotaScheduler,
          ],
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

function hasDingTalkRepository(
  repository: RuntimeAgentRepository,
): repository is RuntimeAgentRepository & DingTalkAuthenticationRepository {
  return (
    typeof repository.createOAuthLoginState === "function" &&
    typeof repository.consumeOAuthLoginState === "function" &&
    typeof repository.findOrCreateDingTalkUser === "function"
  );
}
