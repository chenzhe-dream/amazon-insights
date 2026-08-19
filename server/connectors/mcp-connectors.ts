import { readServerConnectorSecret } from "../config/connector-secrets.mjs";
import {
  callSellerSpriteMcpTool,
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
  ConnectorExecutionPolicy,
  ConnectorId,
  ConnectorMap,
  ConnectorRequest,
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
  env?: AgentEnvironment;
  resolveCredential?: (connectorId: ConnectorId) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  sleep?: (durationMs: number) => Promise<void>;
  policy?: Readonly<ConnectorExecutionPolicy>;
}

function dependencies(input: McpConnectorDependencies) {
  const env = input.env ?? process.env;
  return {
    env,
    resolveCredential:
      input.resolveCredential ??
      (async (connectorId: ConnectorId) =>
        readServerConnectorSecret(connectorId, env)),
    fetchImpl: input.fetchImpl ?? fetch,
    clock: input.clock ?? (() => new Date()),
    sleep:
      input.sleep ??
      ((durationMs: number) =>
        new Promise<void>(resolve => setTimeout(resolve, durationMs))),
    policy: input.policy ?? DEFAULT_POLICY,
  };
}

function connector(
  id: ConnectorId,
  input: McpConnectorDependencies,
  transport: (
    request: ConnectorRequest,
    signal: AbortSignal,
    credential: string,
    env: AgentEnvironment,
    fetchImpl: typeof fetch,
  ) => Promise<unknown>,
  probeTransport: (
    signal: AbortSignal,
    credential: string,
    env: AgentEnvironment,
    fetchImpl: typeof fetch,
  ) => Promise<unknown>,
): RemoteMcpConnector {
  const resolved = dependencies(input);
  return createRemoteMcpConnector({
    id,
    resolveCredential: () => resolved.resolveCredential(id),
    transport: (request, signal, credential) =>
      transport(request, signal, credential, resolved.env, resolved.fetchImpl),
    probeTransport: (signal, credential) =>
      probeTransport(signal, credential, resolved.env, resolved.fetchImpl),
    clock: resolved.clock,
    sleep: resolved.sleep,
    policy: resolved.policy,
  });
}

export function createSifConnector(
  input: McpConnectorDependencies = {},
): RemoteMcpConnector {
  return connector(
    "sif",
    input,
    (request, signal, credential, env, fetchImpl) =>
      callSifTool(request.operation, request.input, {
        env: { ...env, SIF_MCP_SECRET: credential } as NodeJS.ProcessEnv,
        fetchImpl,
        signal,
      }),
    (signal, credential, env, fetchImpl) =>
      requestSifMcp("tools/list", {}, {
        env: { ...env, SIF_MCP_SECRET: credential } as NodeJS.ProcessEnv,
        fetchImpl,
        signal,
      }),
  );
}

export function createSorftimeConnector(
  input: McpConnectorDependencies = {},
): RemoteMcpConnector {
  return connector(
    "sorftime",
    input,
    (request, signal, credential, _env, fetchImpl) =>
      callSorftimeTool(
        credential,
        request.operation,
        request.input,
        { fetchImpl, signal },
      ),
    (signal, credential, _env, fetchImpl) =>
      requestSorftimeMcp(
        credential,
        "tools/list",
        {},
        { fetchImpl, signal },
      ),
  );
}

export function createSellerSpriteConnector(
  input: McpConnectorDependencies = {},
): RemoteMcpConnector {
  return connector(
    "sellerSprite",
    input,
    (request, signal, credential, _env, fetchImpl) =>
      callSellerSpriteMcpTool(
        credential,
        request.operation,
        request.input,
        { fetchImpl, signal },
      ),
    (signal, credential, _env, fetchImpl) =>
      requestSellerSpriteMcp(
        credential,
        "tools/list",
        {},
        { fetchImpl, signal },
      ),
  );
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
