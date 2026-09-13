import { readServerConnectorSecret } from "../config/connector-secrets.mjs";
import { ConnectorError, type ConnectorCredentialScope, type ConnectorId } from "../connectors/connector-contract";

type OrganizationCredentialService = {
  resolve(connectorId: ConnectorId): Promise<Readonly<{ secret: string | null }>>;
};

/** Request-scoped workers can use managed credentials without an AI execution identity. */
export function createScopedConnectorCredentialResolver(input: {
  env: Readonly<Record<string, string | undefined>>;
  executionOrganizationId?: string | null;
  serviceForOrganization: (organizationId: string) => OrganizationCredentialService;
}) {
  return async (connectorId: ConnectorId, scope?: ConnectorCredentialScope): Promise<string | null> => {
    if (scope && !scope.organizationId?.trim()) {
      throw new ConnectorError(connectorId, "configuration", false);
    }
    const organizationId = scope?.organizationId ?? input.executionOrganizationId;
    if (organizationId?.trim()) {
      return (await input.serviceForOrganization(organizationId).resolve(connectorId)).secret;
    }
    // Preserve the existing unscoped connector behavior, including missing secrets.
    return readServerConnectorSecret(connectorId, input.env);
  };
}
