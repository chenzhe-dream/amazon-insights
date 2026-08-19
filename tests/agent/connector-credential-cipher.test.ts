import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  ConnectorCredentialCipherError,
  createConnectorCredentialCipher,
} from "../../server/security/connector-credential-cipher";

const masterKey = Buffer.alloc(32, 0x5a).toString("base64url");

test("AES-256-GCM credentials round-trip only under their exact AAD identity", () => {
  const cipher = createConnectorCredentialCipher({
    AGENT_CONNECTOR_CREDENTIAL_MASTER_KEY: masterKey,
  });
  const secret = "sentinel-credential-value";
  const encrypted = cipher.encrypt({
    organizationId: "org-1",
    connector: "sif",
    version: 7,
    plaintext: secret,
  });

  assert.equal(encrypted.nonce.byteLength, 12);
  assert.equal(encrypted.authTag.byteLength, 16);
  assert.match(encrypted.keyId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(encrypted.ciphertext.includes(Buffer.from(secret)), false);
  assert.equal(
    cipher.decrypt({
      organizationId: "org-1",
      connector: "sif",
      version: 7,
      ...encrypted,
    }),
    secret,
  );

  for (const mismatch of [
    { organizationId: "org-2", connector: "sif" as const, version: 7 },
    { organizationId: "org-1", connector: "sorftime" as const, version: 7 },
    { organizationId: "org-1", connector: "sif" as const, version: 8 },
  ]) {
    assert.throws(
      () => cipher.decrypt({ ...mismatch, ...encrypted }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorCredentialCipherError);
        assert.equal(error.message, "Connector credential could not be decrypted");
        assert.doesNotMatch(error.message, /sentinel|org-|sif|sorftime/i);
        return true;
      },
    );
  }
});

test("credential cipher rejects invalid master keys and plaintext bounds safely", () => {
  for (const invalid of [
    undefined,
    "",
    "not-base64url!",
    Buffer.alloc(31).toString("base64url"),
    `${masterKey}=`,
  ]) {
    assert.throws(
      () => createConnectorCredentialCipher({
        AGENT_CONNECTOR_CREDENTIAL_MASTER_KEY: invalid,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorCredentialCipherError);
        assert.equal(error.message, "Connector credential encryption is not configured");
        assert.doesNotMatch(error.message, /not-base64url|Wlpa/i);
        return true;
      },
    );
  }

  const cipher = createConnectorCredentialCipher({
    AGENT_CONNECTOR_CREDENTIAL_MASTER_KEY: masterKey,
  });
  for (const plaintext of ["", "x".repeat(8_193)]) {
    assert.throws(
      () => cipher.encrypt({
        organizationId: "org-1",
        connector: "sif",
        version: 1,
        plaintext,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorCredentialCipherError);
        assert.equal(error.message, "Connector credential is invalid");
        return true;
      },
    );
  }
});
