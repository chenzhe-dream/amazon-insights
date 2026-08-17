import type { FastifyInstance } from "fastify";

import {
  ConnectorHealthSchema,
  ConnectorIdSchema,
} from "../../shared/agent-contracts";
import type { ConnectorProbeService } from "../services/connector-probe-service";
import { ContractRouteError } from "./analysis-runs";

export function registerConnectorRoutes(
  app: FastifyInstance,
  service: ConnectorProbeService | null,
) {
  app.post("/v1/connectors/:connectorId/probe", async (request) => {
    const parsed = ConnectorIdSchema.safeParse(
      (request.params as { connectorId?: unknown }).connectorId,
    );
    if (!parsed.success) {
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Connector identifier is invalid",
      );
    }
    if (!service) {
      throw new ContractRouteError(
        503,
        "CONFIGURATION_ERROR",
        "Connector health probing is not configured",
      );
    }
    return ConnectorHealthSchema.parse(await service.probe(parsed.data));
  });
}
