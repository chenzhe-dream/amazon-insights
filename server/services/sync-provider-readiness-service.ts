import type { ConnectorId } from "../connectors/connector-contract";
import type { ConnectorStatusRepository } from "../db/repository";
import type {
  ConnectorCredentialService,
  SafeConnectorCredentialState,
} from "./connector-credential-service";

export type SyncProviderReadinessCauseCode =
  | "NOT_CONFIGURED"
  | "PROBE_REQUIRED"
  | "PROBE_FAILED"
  | "PROVIDER_DEGRADED";

export type SyncProviderReadinessDetail = Readonly<{
  connectorId: ConnectorId;
  causeCode: SyncProviderReadinessCauseCode;
}>;

export type SyncProviderReadinessPlan = Readonly<{
  requiredConnectorIds: readonly ConnectorId[];
  readyConnectorIds: readonly ConnectorId[];
  unavailable: readonly SyncProviderReadinessDetail[];
}>;

type AutomaticSyncStage =
  | "catalog"
  | "keywords"
  | "reviews"
  | "sales_trend"
  | "child_sales"
  | "price_strategy"
  | "fba"
  | "listing"
  | "category"
  | "traffic";

const STAGE_CONNECTORS: Readonly<Record<AutomaticSyncStage, readonly ConnectorId[]>> = Object.freeze({
  catalog: ["sellerSprite"],
  keywords: ["sif"],
  reviews: ["sorftime"],
  sales_trend: ["sorftime"],
  child_sales: ["sorftime"],
  price_strategy: ["sorftime"],
  fba: ["sorftime"],
  listing: ["sorftime"],
  category: ["sorftime"],
  traffic: ["sif"],
});

export class SyncProviderReadinessError extends Error {
  constructor(readonly details: readonly SyncProviderReadinessDetail[]) {
    super("Required connectors are not ready");
    this.name = "SyncProviderReadinessError";
  }
}

export class SyncProviderReadinessService {
  readonly #credentialServiceResolver: (
    organizationId: string,
  ) => Pick<ConnectorCredentialService, "listSafeStates">;
  readonly #connectorStatuses: Pick<ConnectorStatusRepository, "findConnectorStatus">;

  constructor(options: {
    credentialServiceResolver(
      organizationId: string,
    ): Pick<ConnectorCredentialService, "listSafeStates">;
    connectorStatuses: Pick<ConnectorStatusRepository, "findConnectorStatus">;
  }) {
    this.#credentialServiceResolver = options.credentialServiceResolver;
    this.#connectorStatuses = options.connectorStatuses;
  }

  async assertReady(input: {
    organizationId: string;
    automaticStages: readonly string[];
  }): Promise<void> {
    const connectorIds = requiredConnectors(input.automaticStages);
    if (connectorIds.length === 0) return;
    const unavailable = await this.#unavailableDetails(input.organizationId, connectorIds);
    if (unavailable.length > 0) throw new SyncProviderReadinessError(unavailable);
  }

  async plan(input: {
    organizationId: string;
    automaticStages: readonly string[];
  }): Promise<SyncProviderReadinessPlan> {
    const requiredConnectorIds = requiredConnectors(input.automaticStages);
    if (requiredConnectorIds.length === 0) {
      return Object.freeze({
        requiredConnectorIds: Object.freeze([]),
        readyConnectorIds: Object.freeze([]),
        unavailable: Object.freeze([]),
      });
    }
    const unavailable = await this.#unavailableDetails(input.organizationId, requiredConnectorIds);
    const unavailableIds = new Set(unavailable.map((detail) => detail.connectorId));
    const readyConnectorIds = requiredConnectorIds.filter((connectorId) => !unavailableIds.has(connectorId));
    if (readyConnectorIds.length === 0) throw new SyncProviderReadinessError(unavailable);
    return Object.freeze({
      requiredConnectorIds: Object.freeze(requiredConnectorIds),
      readyConnectorIds: Object.freeze(readyConnectorIds),
      unavailable: Object.freeze(unavailable),
    });
  }

  async #unavailableDetails(
    organizationId: string,
    connectorIds: readonly ConnectorId[],
  ): Promise<SyncProviderReadinessDetail[]> {
    const credentials = new Map(
      (await this.#credentialServiceResolver(organizationId).listSafeStates())
        .map((state) => [state.connectorId, state]),
    );
    const details = await Promise.all(connectorIds.map(async (connectorId) => {
      const credential = credentials.get(connectorId);
      if (!credential?.configured) {
        return { connectorId, causeCode: "NOT_CONFIGURED" } as const;
      }
      const status = await this.#connectorStatuses.findConnectorStatus(
        organizationId,
        connectorId,
      );
      if (!status || !isProbeCurrentForCredential(status.lastCheckedAt, credential)) {
        return { connectorId, causeCode: "PROBE_REQUIRED" } as const;
      }
      if (status.health !== "available") {
        return {
          connectorId,
          causeCode: isProviderDegraded(status.lastError?.message)
            ? "PROVIDER_DEGRADED"
            : "PROBE_FAILED",
        } as const;
      }
      return null;
    }));
    return details.flatMap((detail) => detail ? [detail] : []);
  }
}

function requiredConnectors(stages: readonly string[]): ConnectorId[] {
  const required = new Set<ConnectorId>();
  for (const stage of stages) {
    if (!(stage in STAGE_CONNECTORS)) continue;
    for (const connectorId of STAGE_CONNECTORS[stage as AutomaticSyncStage]) {
      required.add(connectorId);
    }
  }
  return [...required];
}

function isProbeCurrentForCredential(
  checkedAt: string | null,
  credential: SafeConnectorCredentialState,
) {
  if (!checkedAt) return false;
  if (credential.source !== "managed" || !credential.updatedAt) return true;
  const checked = Date.parse(checkedAt);
  const updated = Date.parse(credential.updatedAt);
  return Number.isFinite(checked) && Number.isFinite(updated) && checked >= updated;
}

function isProviderDegraded(message: string | null | undefined) {
  return typeof message === "string" && /^Provider degraded:/.test(message);
}
