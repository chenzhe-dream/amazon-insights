import { randomUUID } from "node:crypto";

import { readServerConnectorSecret } from "../config/connector-secrets.mjs";
import {
  CONNECTOR_IDS,
  type ConnectorId,
} from "../connectors/connector-contract";
import {
  ConnectorCredentialConflictError,
  type ConnectorCredentialRepository,
} from "../db/repository";
import {
  ConnectorCredentialCipherError,
  type ConnectorCredentialCipher,
} from "../security/connector-credential-cipher";

type AgentEnvironment = Readonly<Record<string, string | undefined>>;

export type ResolvedConnectorCredential = Readonly<{
  configured: boolean;
  secret: string | null;
  source: "managed" | "environment" | "none";
  version: number | null;
}>;

export type SafeConnectorCredentialState = Readonly<{
  connectorId: ConnectorId;
  configured: boolean;
  managed: boolean;
  version: number | null;
  updatedAt: string | null;
}>;

export interface ConnectorCredentialServiceOptions {
  readonly repository: ConnectorCredentialRepository;
  readonly cipher?: ConnectorCredentialCipher | null;
  readonly organizationId: string;
  readonly env: AgentEnvironment;
  readonly clock?: () => Date;
}

export class ConnectorCredentialService {
  readonly #repository: ConnectorCredentialRepository;
  readonly #cipher: ConnectorCredentialCipher | null;
  readonly #organizationId: string;
  readonly #env: AgentEnvironment;
  readonly #clock: () => Date;

  constructor(options: ConnectorCredentialServiceOptions) {
    this.#repository = options.repository;
    this.#cipher = options.cipher ?? null;
    this.#organizationId = options.organizationId;
    this.#env = options.env;
    this.#clock = options.clock ?? (() => new Date());
  }

  async resolve(connector: ConnectorId): Promise<ResolvedConnectorCredential> {
    const latest = await this.#repository.findLatestConnectorCredential(
      this.#organizationId,
      connector,
    );
    if (!latest) {
      const secret = readServerConnectorSecret(connector, this.#env);
      return Object.freeze({
        configured: secret !== null,
        secret,
        source: secret === null ? "none" : "environment",
        version: null,
      });
    }
    if (latest.status === "revoked") {
      return Object.freeze({
        configured: false,
        secret: null,
        source: "none",
        version: latest.version,
      });
    }
    if (!this.#cipher) {
      throw new ConnectorCredentialCipherError(
        "Connector credential could not be decrypted",
      );
    }
    const secret = this.#cipher.decrypt({
      organizationId: latest.organizationId,
      connector: latest.connector,
      version: latest.version,
      ciphertext: Buffer.from(latest.ciphertext),
      nonce: Buffer.from(latest.nonce),
      authTag: Buffer.from(latest.authTag),
      keyId: latest.keyId,
    });
    return Object.freeze({
      configured: true,
      secret,
      source: "managed",
      version: latest.version,
    });
  }

  async listSafeStates(): Promise<readonly SafeConnectorCredentialState[]> {
    return Promise.all(CONNECTOR_IDS.map((connector) => this.getSafeState(connector)));
  }

  async getSafeState(
    connector: ConnectorId,
  ): Promise<SafeConnectorCredentialState> {
    const latest = await this.#repository.findLatestConnectorCredential(
      this.#organizationId,
      connector,
    );
    if (latest) {
      return Object.freeze({
        connectorId: connector,
        configured: latest.status === "active",
        managed: true,
        version: latest.version,
        updatedAt: latest.revokedAt ?? latest.createdAt,
      });
    }
    const configured = readServerConnectorSecret(connector, this.#env) !== null;
    return Object.freeze({
      connectorId: connector,
      configured,
      managed: false,
      version: null,
      updatedAt: null,
    });
  }

  async rotate(input: {
    connector: ConnectorId;
    secret: string;
    actorUserId: string;
  }): Promise<SafeConnectorCredentialState> {
    if (!this.#cipher) {
      throw new ConnectorCredentialCipherError(
        "Connector credential encryption is not configured",
      );
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await this.#repository.findLatestConnectorCredential(
        this.#organizationId,
        input.connector,
      );
      const version = (latest?.version ?? 0) + 1;
      const encrypted = this.#cipher.encrypt({
        organizationId: this.#organizationId,
        connector: input.connector,
        version,
        plaintext: input.secret,
      });
      const rotatedAt = this.#now();
      try {
        const stored = await this.#repository.rotateConnectorCredential({
          id: randomUUID(),
          organizationId: this.#organizationId,
          connector: input.connector,
          version,
          expectedLatestVersion: latest?.version ?? null,
          ...encrypted,
          actorUserId: input.actorUserId,
          rotatedAt,
          statusId: randomUUID(),
          auditEventId: randomUUID(),
        });
        return Object.freeze({
          connectorId: input.connector,
          configured: true,
          managed: true,
          version: stored.version,
          updatedAt: stored.createdAt,
        });
      } catch (error) {
        if (!(error instanceof ConnectorCredentialConflictError) || attempt === 2) {
          throw error;
        }
      }
    }
    throw new ConnectorCredentialConflictError();
  }

  async revoke(input: {
    connector: ConnectorId;
    actorUserId: string;
  }): Promise<SafeConnectorCredentialState> {
    if (!this.#cipher) {
      throw new ConnectorCredentialCipherError(
        "Connector credential encryption is not configured",
      );
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await this.#repository.findLatestConnectorCredential(
        this.#organizationId,
        input.connector,
      );
      const tombstoneVersion = latest?.version ?? 1;
      const encrypted = this.#cipher.encrypt({
        organizationId: this.#organizationId,
        connector: input.connector,
        version: tombstoneVersion,
        plaintext: "revoked",
      });
      const revokedAt = this.#now();
      try {
        const result = await this.#repository.revokeConnectorCredential({
          organizationId: this.#organizationId,
          connector: input.connector,
          expectedLatestVersion: latest?.version ?? null,
          actorUserId: input.actorUserId,
          revokedAt,
          tombstoneId: randomUUID(),
          ...encrypted,
          statusId: randomUUID(),
          auditEventId: randomUUID(),
        });
        return Object.freeze({
          connectorId: input.connector,
          configured: false,
          managed: true,
          version: result.credential.version,
          updatedAt: result.credential.revokedAt ?? revokedAt,
        });
      } catch (error) {
        if (!(error instanceof ConnectorCredentialConflictError) || attempt === 2) {
          throw error;
        }
      }
    }
    throw new ConnectorCredentialConflictError();
  }

  #now(): string {
    const date = this.#clock();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new TypeError("Connector credential clock is invalid");
    }
    return date.toISOString();
  }
}
