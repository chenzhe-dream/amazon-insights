import {SavedSourceMissingError} from '../../scripts/lib/sorftime-source-cache.mjs';
import { readServerConnectorSecret } from "../config/connector-secrets.mjs";
import {
  callSellerSpriteMcpTool,
  createSellerSpriteSessionPool,
  requestSellerSpriteMcp,
} from "../../scripts/lib/sellersprite-mcp-client.mjs";
import {
  callSifTool,
  requestSifMcp,
} from "../../scripts/lib/sif-mcp-client.mjs";
import {
  callSorftimeTool,
  requestSorftimeMcp,
} from "../../scripts/lib/sorftime-mcp-client.mjs";
import type {
  ResourceGovernor,
} from "../db/concurrency-control-repository";
import type {
  ConnectorCredentialScope,
  ConnectorExecutionPolicy,
  ConnectorId,
  ConnectorMap,
  RemoteMcpConnector,
} from "./connector-contract";
import { createRemoteMcpConnector } from "./remote-mcp-connector";

type AgentEnvironment = Readonly<Record<string, string | undefined>>;

const DEFAULT_POLICY: Readonly<ConnectorExecutionPolicy> = Object.freeze({
  timeoutMs: 15_000,
  maxAttempts: 2,
  retryDelayMs: 100,
  maxConcurrent: 1,
  maxQueue: 16,
});

export interface McpConnectorDependencies {
  sourceCache?: ReturnType<typeof import("../../scripts/lib/sorftime-source-cache.mjs").createSorftimeSourceCache>;
  env?: AgentEnvironment;
  resolveCredential?: (
    connectorId: ConnectorId,
    scope?: ConnectorCredentialScope,
  ) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  sleep?: (durationMs: number) => Promise<void>;
  policy?: Readonly<ConnectorExecutionPolicy>;
  resourceGovernor?: ResourceGovernor;
}

function dependencies(input: McpConnectorDependencies) {
  const env = input.env ?? process.env;
  return {
    env,
    resolveCredential:
      input.resolveCredential ??
      (async (connectorId: ConnectorId) =>
        readServerConnectorSecret(connectorId, env)),
    fetchImpl: env.MARKET_EXTERNAL_COLLECTION_MODE==='saved-only' ? (async()=>{throw new SavedSourceMissingError();}) as typeof fetch : input.fetchImpl ?? fetch,
    clock: input.clock ?? (() => new Date()),
    sleep:
      input.sleep ??
      ((durationMs: number) =>
        new Promise<void>(resolve => setTimeout(resolve, durationMs))),
    policy: input.policy ?? DEFAULT_POLICY,
    resourceGovernor: input.resourceGovernor,
  };
}

export function createSifConnector(
  input: McpConnectorDependencies = {},
): RemoteMcpConnector {
  const resolved = dependencies(input);
  return createRemoteMcpConnector({
    id: 'sif', physicalGovernance: 'transport-dispatch',
    resolveCredential: scope => resolved.resolveCredential('sif',scope),
    transport: (request, signal, credential, context) =>
      callSifTool(request.operation, request.input, {
        env: { ...resolved.env, SIF_MCP_SECRET: credential, AGENT_EXECUTION_ORGANIZATION_ID: undefined, AGENT_SYNC_JOB_ID: undefined },
        fetchImpl: resolved.fetchImpl, signal, sourceCache: input.sourceCache, savedOnly: request.savedOnly,
        resourceGovernor: context.resourceGovernor ?? undefined,
        organizationId: context.governorScope?.organizationId ?? null,
        jobId: context.governorScope?.jobId ?? null, attemptKind: context.attemptKind,
      }),
    probeTransport: (signal, credential, context) =>
      requestSifMcp("tools/list", {}, {
        env: { ...resolved.env, SIF_MCP_SECRET: credential, AGENT_EXECUTION_ORGANIZATION_ID: undefined, AGENT_SYNC_JOB_ID: undefined },
        fetchImpl: resolved.fetchImpl, signal,
        resourceGovernor: context.resourceGovernor ?? undefined,
        organizationId: context.governorScope?.organizationId ?? null,
        jobId: context.governorScope?.jobId ?? null, attemptKind: context.attemptKind,
      }),
    clock: resolved.clock, sleep: resolved.sleep, policy: resolved.policy,
    resourceGovernor: resolved.resourceGovernor,
  });
}

export function createSorftimeConnector(
  input: McpConnectorDependencies = {},
): RemoteMcpConnector {
  const resolved = dependencies(input);
  return createRemoteMcpConnector({
    id: "sorftime",
    physicalGovernance: "transport-dispatch",
    resolveCredential: scope => resolved.resolveCredential("sorftime", scope),
    transport: (request, signal, credential, context) => callSorftimeTool(
      credential, request.operation, request.input, {
        sourceCache: input.sourceCache, savedOnly: request.savedOnly,
        fetchImpl: resolved.fetchImpl, signal,
        resourceGovernor: context.resourceGovernor ?? undefined,
        organizationId: context.governorScope?.organizationId ?? null,
        jobId: context.governorScope?.jobId ?? null,
        attemptKind: context.attemptKind,
        env: {...resolved.env, AGENT_EXECUTION_ORGANIZATION_ID: undefined, AGENT_SYNC_JOB_ID: undefined},
      }),
    probeTransport: (signal, credential, context) => requestSorftimeMcp(credential, "tools/list", {}, {
      fetchImpl: resolved.fetchImpl, signal,
      resourceGovernor: context.resourceGovernor ?? undefined,
      organizationId: context.governorScope?.organizationId ?? null,
      jobId: context.governorScope?.jobId ?? null,
      attemptKind: context.attemptKind,
      env: {...resolved.env, AGENT_EXECUTION_ORGANIZATION_ID: undefined, AGENT_SYNC_JOB_ID: undefined},
    }),
    clock: resolved.clock, sleep: resolved.sleep,
    // With shared caching, the physical client owns its bounded connect retry.
    policy: {...resolved.policy, maxAttempts: input.sourceCache || resolved.env.SORFTIME_SOURCE_CACHE_ENABLED === '1' ? 1 : resolved.policy.maxAttempts},
    resourceGovernor: resolved.resourceGovernor,
  });
}

export function createSellerSpriteConnector(
  input: McpConnectorDependencies = {},
): RemoteMcpConnector {
  const resolved = dependencies(input);
  const sessionPool = createSellerSpriteSessionPool();
  const result = createRemoteMcpConnector({
    id: "sellerSprite",
    physicalGovernance: "transport-dispatch",
    resolveCredential: (scope) =>
      resolved.resolveCredential("sellerSprite", scope),
    transport: (request, signal, credential, context) =>
      callSellerSpriteMcpTool(
        credential,
        request.operation,
        request.input,
        {
          sessionPool,
          sourceCache: input.sourceCache, savedOnly: request.savedOnly,
          sessionScope: request.sessionScope,
          fetchImpl: resolved.fetchImpl,
          signal,
          resourceGovernor: context.resourceGovernor ?? undefined,
          organizationId: context.governorScope?.organizationId ?? null,
          jobId: context.governorScope?.jobId ?? null,
          attemptKind: context.attemptKind,
          env: {
            ...resolved.env,
            AGENT_EXECUTION_ORGANIZATION_ID: undefined,
            AGENT_SYNC_JOB_ID: undefined,
          },
          timeoutMs: context.timeoutMs,
        },
      ),
    probeTransport: (signal, credential, context) =>
      requestSellerSpriteMcp(
        credential,
        "tools/list",
        {},
        {
          fetchImpl: resolved.fetchImpl,
          signal,
          resourceGovernor: context.resourceGovernor ?? undefined,
          organizationId: context.governorScope?.organizationId ?? null,
          jobId: context.governorScope?.jobId ?? null,
          attemptKind: context.attemptKind,
          env: {
            ...resolved.env,
            AGENT_EXECUTION_ORGANIZATION_ID: undefined,
            AGENT_SYNC_JOB_ID: undefined,
          },
          timeoutMs: context.timeoutMs,
        },
      ),
    clock: resolved.clock,
    sleep: resolved.sleep,
    policy: resolved.policy,
    resourceGovernor: resolved.resourceGovernor,
  });
  return { ...result, close: () => sessionPool.close() };
}

export function createRemoteMcpConnectors(
  input: McpConnectorDependencies = {},
): ConnectorMap {
  return Object.freeze({
    sif: createSifConnector(input),
    sorftime: createSorftimeConnector(input),
    sellerSprite: createSellerSpriteConnector(input),
  });
}
