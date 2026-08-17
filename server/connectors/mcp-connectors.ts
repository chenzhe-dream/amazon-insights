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
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  sleep?: (durationMs: number) => Promise<void>;
  policy?: Readonly<ConnectorExecutionPolicy>;
}

function dependencies(input: McpConnectorDependencies) {
  return {
    env: input.env ?? process.env,
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
  configured: (env: AgentEnvironment) => boolean,
  transport: (
    request: ConnectorRequest,
    signal: AbortSignal,
    env: AgentEnvironment,
    fetchImpl: typeof fetch,
  ) => Promise<unknown>,
  probeTransport: (
    signal: AbortSignal,
    env: AgentEnvironment,
    fetchImpl: typeof fetch,
  ) => Promise<unknown>,
): RemoteMcpConnector {
  const resolved = dependencies(input);
  return createRemoteMcpConnector({
    id,
    configured: () => configured(resolved.env),
    transport: (request, signal) =>
      transport(request, signal, resolved.env, resolved.fetchImpl),
    probeTransport: signal =>
      probeTransport(signal, resolved.env, resolved.fetchImpl),
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
    env => readServerConnectorSecret("sif", env) !== null,
    (request, signal, env, fetchImpl) =>
      callSifTool(request.operation, request.input, { env, fetchImpl, signal }),
    (signal, env, fetchImpl) =>
      requestSifMcp("tools/list", {}, { env, fetchImpl, signal }),
  );
}

export function createSorftimeConnector(
  input: McpConnectorDependencies = {},
): RemoteMcpConnector {
  return connector(
    "sorftime",
    input,
    env => readServerConnectorSecret("sorftime", env) !== null,
    (request, signal, env, fetchImpl) =>
      callSorftimeTool(
        readServerConnectorSecret("sorftime", env),
        request.operation,
        request.input,
        { fetchImpl, signal },
      ),
    (signal, env, fetchImpl) =>
      requestSorftimeMcp(
        readServerConnectorSecret("sorftime", env),
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
    env => readServerConnectorSecret("sellerSprite", env) !== null,
    (request, signal, env, fetchImpl) =>
      callSellerSpriteMcpTool(
        readServerConnectorSecret("sellerSprite", env),
        request.operation,
        request.input,
        { fetchImpl, signal },
      ),
    (signal, env, fetchImpl) =>
      requestSellerSpriteMcp(
        readServerConnectorSecret("sellerSprite", env),
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
