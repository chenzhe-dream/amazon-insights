import { randomUUID } from "node:crypto";

import { getServerConnectorSecretState } from "../config/connector-secrets.mjs";
import {
  CONNECTOR_IDS,
  type ConnectorHealth,
  type ConnectorId,
  type ConnectorMap,
} from "../connectors/connector-contract";
import type { ConnectorStatusRepository } from "../db/repository";

type AgentEnvironment = Readonly<Record<string, string | undefined>>;
export type ConnectorCapabilityState = Readonly<
  Omit<ConnectorHealth, "connectorId">
>;
export type ConnectorCapabilities = Readonly<
  Record<ConnectorId, ConnectorCapabilityState>
>;

export interface ConnectorProbeServiceOptions {
  repository: ConnectorStatusRepository;
  organizationId: string;
  env: AgentEnvironment;
  connectors: ConnectorMap;
  clock?: () => Date;
}

const DISPLAY_NAMES: Readonly<Record<ConnectorId, string>> = Object.freeze({
  sif: "SIF",
  sorftime: "Sorftime",
  sellerSprite: "SellerSprite",
});

const SAFE_UNAVAILABLE_REASONS = new Set([
  "Connector configuration is unavailable",
  "Connector authentication failed",
  "Connector rate limit was exceeded",
  "Connector request timed out",
  "Connector upstream is temporarily unavailable",
  "Connector upstream request failed",
  "Connector returned an invalid response",
]);

function safeReason(connectorId: ConnectorId, reason: string | null) {
  const missing = `${DISPLAY_NAMES[connectorId]} connector credential is not configured`;
  if (reason === missing || (reason && SAFE_UNAVAILABLE_REASONS.has(reason))) {
    return reason;
  }
  return "Connector is unavailable";
}

function passiveState(
  connectorId: ConnectorId,
  configured: boolean,
): ConnectorCapabilityState {
  return Object.freeze({
    configured,
    available: false,
    reason: configured
      ? "Connector health has not been checked"
      : `${DISPLAY_NAMES[connectorId]} connector credential is not configured`,
    checkedAt: null,
  });
}

export class ConnectorProbeService {
  readonly #repository: ConnectorStatusRepository;
  readonly #organizationId: string;
  readonly #env: AgentEnvironment;
  readonly #connectors: ConnectorMap;
  readonly #clock: () => Date;

  constructor(options: ConnectorProbeServiceOptions) {
    this.#repository = options.repository;
    this.#organizationId = options.organizationId;
    this.#env = options.env;
    this.#connectors = options.connectors;
    this.#clock = options.clock ?? (() => new Date());
  }

  async probe(connectorId: ConnectorId): Promise<ConnectorHealth> {
    const result = await this.#connectors[connectorId].probe();
    const checkedAt = result.checkedAt ?? this.#clock().toISOString();
    const health = Object.freeze({
      connectorId,
      configured: result.configured,
      available: result.available,
      reason: result.available ? null : safeReason(connectorId, result.reason),
      checkedAt,
    });
    await this.#repository.upsertConnectorStatus({
      id: randomUUID(),
      organizationId: this.#organizationId,
      connector: connectorId,
      configured: health.configured,
      health: health.available ? "available" : "unavailable",
      lastCheckedAt: checkedAt,
      lastError:
        health.reason === null
          ? null
          : { code: "probe-failed", message: health.reason },
      updatedAt: checkedAt,
    });
    return health;
  }

  async getCapabilities(): Promise<ConnectorCapabilities> {
    const configured = getServerConnectorSecretState(this.#env);
    const rows = await this.#repository.listConnectorStatuses(
      this.#organizationId,
    );
    const byConnector = new Map(rows.map((row) => [row.connector, row]));
    return Object.freeze(
      Object.fromEntries(
        CONNECTOR_IDS.map((connectorId) => {
          const row = byConnector.get(connectorId);
          if (!configured[connectorId] || !row) {
            return [
              connectorId,
              passiveState(connectorId, configured[connectorId]),
            ];
          }
          return [
            connectorId,
            Object.freeze({
              configured: true,
              available: row.health === "available",
              reason:
                row.health === "available"
                  ? null
                  : safeReason(connectorId, row.lastError?.message ?? null),
              checkedAt: row.lastCheckedAt,
            }),
          ];
        }),
      ) as Record<ConnectorId, ConnectorCapabilityState>,
    );
  }
}
