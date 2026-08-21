# Remote MCP Connectors Design

## Goal

Complete OpenSpec 11.2 with one server-side connector contract for SIF, Sorftime, and SellerSprite. The contract provides bounded execution, normalized results, safe health state, and source metadata while preserving the existing script transports and avoiding DataSnapshot/job work reserved for 11.3.

## Scope

- Add a shared `RemoteMcpConnector` contract and executor in `server/connectors`.
- Add three thin adapters over the existing Node MCP clients.
- Add an explicit on-demand `tools/list` health probe service and internal HTTP route.
- Reuse the existing `connector_status` table through minimal repository methods; no migration is required.
- Extend connector capabilities with `checkedAt` while keeping secrets, headers, endpoint URLs, raw responses, and thrown error objects out of responses and persistence.
- Do not run a probe during Agent Service construction or startup. Startup reads only configured state and last-known persisted status; connector failures never prevent the service from listening.

## Contract

```ts
type ConnectorId = "sif" | "sorftime" | "sellerSprite";

interface ConnectorRequest {
  operation: string;
  input: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

interface ConnectorSourceMetadata {
  connectorId: ConnectorId;
  operation: string;
  fetchedAt: string;
  attemptCount: number;
  protocol: "mcp-json-rpc";
}

interface ConnectorResult {
  data: Readonly<Record<string, unknown>> | readonly unknown[];
  source: Readonly<ConnectorSourceMetadata>;
}

interface ConnectorHealth {
  connectorId: ConnectorId;
  configured: boolean;
  available: boolean;
  reason: string | null;
  checkedAt: string | null;
}

interface RemoteMcpConnector {
  readonly id: ConnectorId;
  execute(request: ConnectorRequest): Promise<ConnectorResult>;
  probe(): Promise<ConnectorHealth>;
}
```

`ConnectorError` carries only a closed code, connector id, retryable flag, and fixed safe message. Allowed codes are `configuration`, `authentication`, `rate-limit`, `timeout`, `upstream-temporary`, `upstream-permanent`, and `malformed-response`. It never exposes `cause`, response bodies, request headers, endpoints, or credential values.

## Execution Policy

The MVP policy is explicit and injected into the executor:

- `timeoutMs`: positive bounded duration per physical attempt.
- `maxAttempts`: exactly `2` in production adapters, meaning at most one retry.
- Retry only `timeout`, `upstream-temporary`, and upstream HTTP `429` classified as `rate-limit`.
- `maxConcurrent`: `1` per connector.
- `maxQueue`: finite. One active call runs, queued calls wait FIFO, and a full queue fails immediately with a sanitized local `rate-limit` error.
- Retry delay is deterministic and injectable in tests. SDK or fetch-level automatic retries are not added.

Each attempt receives an AbortSignal. A timeout aborts that attempt, waits the configured retry delay when retryable, and never leaves a transport promise authorized to produce a valid result after the connector call has settled.

## Adapters and Parsing

The existing `scripts/lib/*-mcp-client.mjs` files remain the low-level HTTP/JSON-RPC transports. They gain a raw MCP request seam accepting `method`, `params`, `signal`, and injected `fetchImpl`; current `call*Tool` functions remain compatible wrappers.

The three adapters load credentials through `server/config/connector-secrets.mjs`, invoke `tools/call` for normal operations, and invoke standard MCP `tools/list` for health. The shared executor accepts only parsed object/array data. Invalid JSON, invalid SSE, JSON-RPC errors, missing result content, or scalar text are `malformed-response` or mapped safe upstream errors. A successful result includes connector id, operation, UTC fetch time, physical attempt count, and protocol, but never the endpoint.

## Passive Status and Explicit Probe

`connector_status` already exists in migration 0001. The repository gains minimal `upsertConnectorStatus`, `findConnectorStatus`, and `listConnectorStatuses` methods with a closed safe error payload.

Agent Service construction creates the connector registry but does not invoke it. Capability reads combine server-secret configured state with the last-known row:

- missing secret: `configured=false`, `available=false`, fixed missing-credential reason;
- configured with no row: `configured=true`, `available=false`, `reason="Connector health has not been checked"`, `checkedAt=null`;
- persisted probe: use only its available/unavailable state, fixed safe reason, and `checkedAt`.

`POST /v1/connectors/:connectorId/probe` is the only production trigger added in 11.2. It uses the existing Agent Service proxy authentication boundary, calls `probe()`, persists the safe status, and returns the same closed health shape. An unconfigured connector fails closed without transport. Probe failure returns/persists an unavailable health result rather than throwing a raw upstream error or stopping Agent Service.

## Tests

All tests use fake environment, clocks, sleeps, and transports. Coverage includes:

- SIF, Sorftime, and SellerSprite success through the same contract;
- malformed JSON/result shape;
- timeout and AbortSignal propagation;
- one transient failure followed by success and retry exhaustion after two attempts;
- FIFO queue behavior and immediate sanitized rejection when the bounded queue is full;
- upstream authentication, 429, 5xx, network, and malformed-response classification;
- absence of credential, header, URL, raw response, and sentinel text in errors, health, repository rows, and capability responses;
- standard source metadata;
- missing configuration performs zero transport calls;
- passive Agent Service startup performs zero transport calls;
- explicit fake probe updates `connector_status` and capability `checkedAt` without affecting service health.

## Non-Goals

- No DataSnapshot creation, acquisition jobs, Worker integration, or generated TypeScript replacement.
- No distributed rate limiter, circuit breaker, connector-specific pagination framework, or production monitoring system.
- No real MCP request, `.env.local` read, or secret requirement during development verification.
