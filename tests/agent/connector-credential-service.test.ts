import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import {
  ConnectorCredentialCipherError,
  createConnectorCredentialCipher,
} from "../../server/security/connector-credential-cipher";
import { ConnectorCredentialService } from "../../server/services/connector-credential-service";

const NOW = "2026-08-19T08:00:00.000Z";
const ADMIN_ID = "10000000-0000-4000-8000-000000000001";
const MEMBER_ID = "10000000-0000-4000-8000-000000000002";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const PASSWORD_RECORD =
  "scrypt-v1$16384$8$1$YWdlbnQtYXV0aC1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const masterKey = Buffer.alloc(32, 0x4a).toString("base64url");

test("credential service projects managed, environment, and none without secrets", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "connector-credential-service-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await repository.createInitialAdmin({
    id: ADMIN_ID,
    organizationId: ORGANIZATION_ID,
    email: "admin@example.com",
    displayName: "Admin",
    passwordHash: PASSWORD_RECORD,
    createdAt: NOW,
  });
  await repository.createUser({
    id: MEMBER_ID,
    organizationId: ORGANIZATION_ID,
    email: "member@example.com",
    displayName: "Member",
    role: "member",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const service = new ConnectorCredentialService({
    repository,
    cipher: createConnectorCredentialCipher({
      AGENT_CONNECTOR_CREDENTIAL_MASTER_KEY: masterKey,
    }),
    organizationId: ORGANIZATION_ID,
    env: { SIF_MCP_SECRET: "sentinel-env-A" },
    clock: () => new Date(NOW),
  });

  assert.deepEqual(await service.resolve("sif"), {
    configured: true,
    secret: "sentinel-env-A",
    source: "environment",
    version: null,
  });
  assert.deepEqual(await service.listSafeStates(), [
    {
      connectorId: "sif",
      configured: true,
      managed: false,
      source: "environment",
      version: null,
      updatedAt: null,
    },
    {
      connectorId: "sorftime",
      configured: false,
      managed: false,
      source: "none",
      version: null,
      updatedAt: null,
    },
    {
      connectorId: "sellerSprite",
      configured: false,
      managed: false,
      source: "none",
      version: null,
      updatedAt: null,
    },
  ]);
  const first = await service.rotate({
    connector: "sif",
    secret: "sentinel-managed-A",
    actorUserId: ADMIN_ID,
  });
  assert.deepEqual(first, {
    connectorId: "sif",
    configured: true,
    managed: true,
    source: "managed",
    version: 1,
    updatedAt: NOW,
  });
  assert.equal((await service.resolve("sif")).secret, "sentinel-managed-A");
  assert.deepEqual(await service.getSafeState("sif"), {
    connectorId: "sif",
    configured: true,
    managed: true,
    source: "managed",
    version: 1,
    updatedAt: NOW,
  });
  await service.rotate({
    connector: "sif",
    secret: "sentinel-managed-B",
    actorUserId: ADMIN_ID,
  });
  assert.equal((await service.resolve("sif")).secret, "sentinel-managed-B");

  await assert.rejects(
    service.rotate({
      connector: "sorftime",
      secret: "member-secret",
      actorUserId: MEMBER_ID,
    }),
  );
  assert.equal(
    await repository.findLatestConnectorCredential(ORGANIZATION_ID, "sorftime"),
    null,
  );

  const revoked = await service.revoke({ connector: "sif", actorUserId: ADMIN_ID });
  assert.deepEqual(revoked, {
    connectorId: "sif",
    configured: true,
    managed: false,
    source: "environment",
    version: null,
    updatedAt: null,
  });
  assert.deepEqual(await service.resolve("sif"), {
    configured: true,
    secret: "sentinel-env-A",
    source: "environment",
    version: null,
  });
  assert.deepEqual(await service.getSafeState("sif"), {
    connectorId: "sif",
    configured: true,
    managed: false,
    source: "environment",
    version: null,
    updatedAt: null,
  });
  assert.doesNotMatch(JSON.stringify(await service.getSafeState("sif")), /sentinel-env-A/);

  await service.rotate({
    connector: "sif",
    secret: "managed-under-original-key",
    actorUserId: ADMIN_ID,
  });
  const wrongKeyService = new ConnectorCredentialService({
    repository,
    cipher: createConnectorCredentialCipher({
      AGENT_CONNECTOR_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 0x4b).toString("base64url"),
    }),
    organizationId: ORGANIZATION_ID,
    env: { SIF_MCP_SECRET: "must-not-fallback" },
    clock: () => new Date(NOW),
  });
  await assert.rejects(
    wrongKeyService.resolve("sif"),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorCredentialCipherError);
      assert.equal(error.message, "Connector credential could not be decrypted");
      assert.doesNotMatch(error.message, /managed|fallback|original/i);
      return true;
    },
  );

  const missingCipher = new ConnectorCredentialService({
    repository,
    organizationId: ORGANIZATION_ID,
    env: { SIF_MCP_SECRET: "must-not-fallback" },
    clock: () => new Date(NOW),
  });
  await assert.rejects(
    missingCipher.resolve("sif"),
    (error: unknown) =>
      error instanceof ConnectorCredentialCipherError &&
      error.message === "Connector credential could not be decrypted",
  );
  const beforeMissingCipherRotate = await repository.findLatestConnectorCredential(
    ORGANIZATION_ID,
    "sorftime",
  );
  await assert.rejects(
    missingCipher.rotate({
      connector: "sorftime",
      secret: "not-written",
      actorUserId: ADMIN_ID,
    }),
    (error: unknown) =>
      error instanceof ConnectorCredentialCipherError &&
      error.message === "Connector credential encryption is not configured",
  );
  assert.deepEqual(
    await repository.findLatestConnectorCredential(ORGANIZATION_ID, "sorftime"),
    beforeMissingCipherRotate,
  );
});
