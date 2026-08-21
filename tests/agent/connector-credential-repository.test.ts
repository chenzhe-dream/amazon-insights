import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ConnectorCredentialAuthorizationError,
  type RotateConnectorCredentialInput,
} from "../../server/db/repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";

const NOW = "2026-08-19T08:00:00.000Z";
const LATER = "2026-08-19T09:00:00.000Z";
const ADMIN_ID = "10000000-0000-4000-8000-000000000001";
const MEMBER_ID = "10000000-0000-4000-8000-000000000002";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const PASSWORD_RECORD =
  "scrypt-v1$16384$8$1$YWdlbnQtYXV0aC1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function encrypted(seed: number) {
  return {
    ciphertext: Buffer.from(`encrypted-${seed}`),
    nonce: Buffer.alloc(12, seed),
    authTag: Buffer.alloc(16, seed),
    keyId: `sha256:${String(seed).padStart(64, "0")}`,
  };
}

function rotation(
  version: number,
  expectedLatestVersion: number | null,
  actorUserId = ADMIN_ID,
): RotateConnectorCredentialInput {
  return {
    id: `30000000-0000-4000-8000-${String(version).padStart(12, "0")}`,
    organizationId: ORGANIZATION_ID,
    connector: "sif",
    version,
    expectedLatestVersion,
    ...encrypted(version),
    actorUserId,
    rotatedAt: version === 1 ? NOW : LATER,
    statusId: `40000000-0000-4000-8000-${String(version).padStart(12, "0")}`,
    auditEventId: `50000000-0000-4000-8000-${String(version).padStart(12, "0")}`,
  };
}

test("SQLite rotates and revokes credentials atomically without persisting plaintext", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "connector-credential-repository-"));
  const path = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
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

  const first = await repository.rotateConnectorCredential(rotation(1, null));
  assert.equal(first.status, "active");
  assert.equal(first.version, 1);
  assert.deepEqual(
    await repository.findLatestConnectorCredential(ORGANIZATION_ID, "sif"),
    first,
  );
  const second = await repository.rotateConnectorCredential(rotation(2, 1));
  assert.equal(second.status, "active");
  assert.equal(second.version, 2);
  assert.deepEqual(await repository.findConnectorStatus(ORGANIZATION_ID, "sif"), {
    id: rotation(1, null).statusId,
    organizationId: ORGANIZATION_ID,
    connector: "sif",
    configured: true,
    health: "unknown",
    lastCheckedAt: null,
    lastError: null,
    updatedAt: LATER,
  });

  const revoked = await repository.revokeConnectorCredential({
    organizationId: ORGANIZATION_ID,
    connector: "sif",
    expectedLatestVersion: 2,
    actorUserId: ADMIN_ID,
    revokedAt: LATER,
    tombstoneId: "60000000-0000-4000-8000-000000000001",
    ...encrypted(3),
    statusId: "70000000-0000-4000-8000-000000000001",
    auditEventId: "80000000-0000-4000-8000-000000000001",
  });
  assert.equal(revoked.changed, true);
  assert.equal(revoked.credential.status, "revoked");
  assert.equal(
    (await repository.findConnectorStatus(ORGANIZATION_ID, "sif"))?.configured,
    false,
  );

  const tombstone = await repository.revokeConnectorCredential({
    organizationId: ORGANIZATION_ID,
    connector: "sorftime",
    expectedLatestVersion: null,
    actorUserId: ADMIN_ID,
    revokedAt: LATER,
    tombstoneId: "60000000-0000-4000-8000-000000000002",
    ...encrypted(1),
    statusId: "70000000-0000-4000-8000-000000000002",
    auditEventId: "80000000-0000-4000-8000-000000000002",
  });
  assert.equal(tombstone.credential.status, "revoked");
  assert.equal(tombstone.credential.version, 1);

  await assert.rejects(
    repository.rotateConnectorCredential(rotation(1, null, MEMBER_ID)),
    ConnectorCredentialAuthorizationError,
  );
  assert.equal(
    await repository.findLatestConnectorCredential(ORGANIZATION_ID, "sellerSprite"),
    null,
  );

  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const persisted = JSON.stringify(
      database.prepare(
        `SELECT connector, version, status, hex(ciphertext) AS ciphertext,
                key_id, created_by, revoked_by
           FROM connector_credentials
          ORDER BY connector, version`,
      ).all(),
    );
    const audit = JSON.stringify(
      database.prepare(
        `SELECT action, target_id, metadata_json
           FROM audit_events
          WHERE action LIKE 'connector.credential-%'
          ORDER BY created_at, id`,
      ).all(),
    );
    assert.doesNotMatch(persisted, /sentinel|credential-value|plaintext/i);
    assert.doesNotMatch(audit, /encrypted-|ciphertext|nonce|auth.?tag|key.?id/i);
    assert.equal(JSON.parse(audit).length, 4);
  } finally {
    database.close();
  }
});
