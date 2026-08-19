import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  CONNECTOR_IDS,
  type ConnectorId,
} from "../connectors/connector-contract";

export type ConnectorCredentialConnector = ConnectorId;

export interface EncryptedConnectorCredential {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly authTag: Buffer;
  readonly keyId: string;
}

interface CredentialIdentity {
  readonly organizationId: string;
  readonly connector: ConnectorCredentialConnector;
  readonly version: number;
}

export class ConnectorCredentialCipherError extends Error {
  constructor(
    message:
      | "Connector credential encryption is not configured"
      | "Connector credential is invalid"
      | "Connector credential could not be decrypted",
  ) {
    super(message);
    this.name = "ConnectorCredentialCipherError";
  }
}

export interface ConnectorCredentialCipher {
  readonly keyId: string;
  encrypt(
    input: CredentialIdentity & Readonly<{ plaintext: string }>,
  ): EncryptedConnectorCredential;
  decrypt(
    input: CredentialIdentity & EncryptedConnectorCredential,
  ): string;
}

type CredentialEnvironment = Readonly<Record<string, string | undefined>>;

function parseMasterKey(env: CredentialEnvironment): Buffer {
  const encoded = env.AGENT_CONNECTOR_CREDENTIAL_MASTER_KEY;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new ConnectorCredentialCipherError(
      "Connector credential encryption is not configured",
    );
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== encoded) {
    throw new ConnectorCredentialCipherError(
      "Connector credential encryption is not configured",
    );
  }
  return key;
}

function additionalAuthenticatedData(identity: CredentialIdentity): Buffer {
  if (
    typeof identity.organizationId !== "string" ||
    !identity.organizationId ||
    identity.organizationId.length > 200 ||
    identity.organizationId.includes("\0") ||
    typeof identity.connector !== "string" ||
    identity.connector.includes("\0") ||
    !CONNECTOR_IDS.includes(identity.connector as ConnectorId) ||
    !Number.isSafeInteger(identity.version) ||
    identity.version < 1
  ) {
    throw new ConnectorCredentialCipherError("Connector credential is invalid");
  }
  return Buffer.from(
    `${identity.organizationId}\0${identity.connector}\0${identity.version}`,
    "utf8",
  );
}

type ConnectorCredentialCipherTestHooks = Readonly<{
  onPlaintextBufferZeroized?: (buffer: Buffer) => void;
}>;

function zeroizePlaintext(
  buffer: Buffer | null,
  hooks: ConnectorCredentialCipherTestHooks,
) {
  if (!buffer) return;
  buffer.fill(0);
  hooks.onPlaintextBufferZeroized?.(buffer);
}

export function createConnectorCredentialCipher(
  env: CredentialEnvironment = process.env,
  testHooks: ConnectorCredentialCipherTestHooks = {},
): ConnectorCredentialCipher {
  const masterKey = parseMasterKey(env);
  const keyId = `sha256:${createHash("sha256").update(masterKey).digest("hex")}`;

  return Object.freeze({
    keyId,
    encrypt(
      input: CredentialIdentity & Readonly<{ plaintext: string }>,
    ): EncryptedConnectorCredential {
      const aad = additionalAuthenticatedData(input);
      let plaintext: Buffer | null = null;
      try {
        plaintext = Buffer.from(input.plaintext, "utf8");
        if (plaintext.byteLength < 1 || plaintext.byteLength > 8_192) {
          throw new ConnectorCredentialCipherError(
            "Connector credential is invalid",
          );
        }
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", masterKey, nonce, {
          authTagLength: 16,
        });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]);
        return Object.freeze({
          ciphertext,
          nonce,
          authTag: cipher.getAuthTag(),
          keyId,
        });
      } catch (error) {
        if (error instanceof ConnectorCredentialCipherError) throw error;
        throw new ConnectorCredentialCipherError(
          "Connector credential is invalid",
        );
      } finally {
        zeroizePlaintext(plaintext, testHooks);
      }
    },
    decrypt(input: CredentialIdentity & EncryptedConnectorCredential): string {
      let updated: Buffer | null = null;
      let final: Buffer | null = null;
      let plaintext: Buffer | null = null;
      try {
        if (
          input.keyId !== keyId ||
          input.nonce.byteLength !== 12 ||
          input.authTag.byteLength !== 16 ||
          input.ciphertext.byteLength < 1
        ) {
          throw new Error("invalid encrypted credential");
        }
        const decipher = createDecipheriv(
          "aes-256-gcm",
          masterKey,
          input.nonce,
          { authTagLength: 16 },
        );
        decipher.setAAD(additionalAuthenticatedData(input));
        decipher.setAuthTag(input.authTag);
        updated = decipher.update(input.ciphertext);
        final = decipher.final();
        plaintext = Buffer.concat([updated, final]);
        const result = plaintext.toString("utf8");
        if (Buffer.byteLength(result, "utf8") < 1 || Buffer.byteLength(result, "utf8") > 8_192) {
          throw new Error("invalid decrypted credential");
        }
        return result;
      } catch {
        throw new ConnectorCredentialCipherError(
          "Connector credential could not be decrypted",
        );
      } finally {
        zeroizePlaintext(updated, testHooks);
        zeroizePlaintext(final, testHooks);
        zeroizePlaintext(plaintext, testHooks);
      }
    },
  });
}
