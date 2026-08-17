export const CONNECTOR_IDS = ["sif", "sorftime", "sellerSprite"] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export type ConnectorErrorCode =
  | "configuration"
  | "authentication"
  | "rate-limit"
  | "timeout"
  | "upstream-temporary"
  | "upstream-permanent"
  | "malformed-response";

const SAFE_ERROR_MESSAGES: Readonly<Record<ConnectorErrorCode, string>> =
  Object.freeze({
    configuration: "Connector configuration is unavailable",
    authentication: "Connector authentication failed",
    "rate-limit": "Connector rate limit was exceeded",
    timeout: "Connector request timed out",
    "upstream-temporary": "Connector upstream is temporarily unavailable",
    "upstream-permanent": "Connector upstream request failed",
    "malformed-response": "Connector returned an invalid response",
  });

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly connectorId: ConnectorId;
  readonly retryable: boolean;

  constructor(
    connectorId: ConnectorId,
    code: ConnectorErrorCode,
    retryable: boolean,
  ) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "ConnectorError";
    this.connectorId = connectorId;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ConnectorRequest {
  operation: string;
  input: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface ConnectorSourceMetadata {
  connectorId: ConnectorId;
  operation: string;
  fetchedAt: string;
  attemptCount: number;
  protocol: "mcp-json-rpc";
}

export interface ConnectorResult {
  data: Readonly<Record<string, unknown>> | readonly unknown[];
  source: Readonly<ConnectorSourceMetadata>;
}

export interface ConnectorHealth {
  connectorId: ConnectorId;
  configured: boolean;
  available: boolean;
  reason: string | null;
  checkedAt: string | null;
}

export interface ConnectorExecutionPolicy {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  maxConcurrent: number;
  maxQueue: number;
}

export interface RemoteMcpConnector {
  readonly id: ConnectorId;
  execute(request: ConnectorRequest): Promise<ConnectorResult>;
  probe(): Promise<ConnectorHealth>;
}

export type ConnectorMap = Readonly<Record<ConnectorId, RemoteMcpConnector>>;
