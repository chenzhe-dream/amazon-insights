import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentService } from "../../server/agent-service";
import { digestSessionToken } from "../../server/auth/session";
import { createSifConnector } from "../../server/connectors/mcp-connectors";
import { ConnectorError } from "../../server/connectors/connector-contract";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { createConnectorCredentialCipher } from "../../server/security/connector-credential-cipher";
import { ConnectorCredentialService } from "../../server/services/connector-credential-service";

const NOW = "2026-08-19T08:00:00.000Z";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const ADMIN_ID = "10000000-0000-4000-8000-000000000001";
const MEMBER_ID = "10000000-0000-4000-8000-000000000002";
const ADMIN_SESSION_ID = "30000000-0000-4000-8000-000000000001";
const MEMBER_SESSION_ID = "30000000-0000-4000-8000-000000000002";
const ADMIN_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MEMBER_TOKEN = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SENTINEL_A = "connector-credential-sentinel-A";
const SENTINEL_B = "connector-credential-sentinel-B";
const PROXY_TOKEN = "credential-tracer-proxy-token";
const ORIGIN = "http://127.0.0.1:31900";
const PASSWORD_RECORD =
  "scrypt-v1$16384$8$1$YWdlbnQtYXV0aC1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("SQLite HTTP tracer rotates live credentials, revokes env fallback, and contains plaintext", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "connector-credential-http-"));
  const path = join(directory, "agent.sqlite");
  const masterKey = Buffer.alloc(32, 0x5a).toString("base64url");
  const env = {
    AGENT_SQLITE_PATH: path,
    AGENT_SQLITE_BUSY_TIMEOUT_MS: "5000",
    AGENT_EXECUTION_ACTOR_ID: ADMIN_ID,
    AGENT_EXECUTION_ORGANIZATION_ID: ORGANIZATION_ID,
    AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN,
    AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN,
    AGENT_CONNECTOR_CREDENTIAL_MASTER_KEY: masterKey,
    SIF_MCP_SECRET: SENTINEL_A,
  };
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedUsersAndSessions(repository);
  const observedProbeCredentials: string[] = [];
  let logs = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const fakeFetch: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    observedProbeCredentials.push(headers.get("secret-key") ?? "");
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      { status: 200 },
    );
  };
  const agent = await createAgentService({
    env,
    repository,
    connectorFetchImpl: fakeFetch,
    logger: { level: "info", stream },
    clock: () => new Date(NOW),
  });
  t.after(async () => {
    await agent.stop();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const responses: string[] = [];
  for (const request of [
    { method: "GET" as const, url: "/v1/connectors" },
    {
      method: "PUT" as const,
      url: "/v1/connectors/sif/credential",
      payload: { secret: SENTINEL_A },
    },
    { method: "DELETE" as const, url: "/v1/connectors/sif/credential" },
  ]) {
    const response = await agent.app.inject({
      ...request,
      headers: sessionHeaders(MEMBER_TOKEN),
    });
    responses.push(response.body);
    assert.equal(response.statusCode, 403);
  }
  assert.equal(
    await repository.findLatestConnectorCredential(ORGANIZATION_ID, "sif"),
    null,
  );

  responses.push(await putCredential(agent, SENTINEL_A));
  responses.push(await probe(agent));
  assert.deepEqual(observedProbeCredentials, [SENTINEL_A]);

  responses.push(await putCredential(agent, SENTINEL_B));
  responses.push(await probe(agent));
  assert.deepEqual(observedProbeCredentials, [SENTINEL_A, SENTINEL_B]);

  const revoked = await agent.app.inject({
    method: "DELETE",
    url: "/v1/connectors/sif/credential",
    headers: sessionHeaders(ADMIN_TOKEN),
  });
  responses.push(revoked.body);
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().configured, false);

  const listed = await agent.app.inject({
    method: "GET",
    url: "/v1/connectors",
    headers: sessionHeaders(ADMIN_TOKEN),
  });
  responses.push(listed.body);
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(
    listed.json().connectors.find((item: { connectorId: string }) => item.connectorId === "sif"),
    {
      connectorId: "sif",
      configured: false,
      managed: true,
      version: 2,
      updatedAt: NOW,
    },
  );
  responses.push(await probe(agent, false));
  assert.deepEqual(observedProbeCredentials, [SENTINEL_A, SENTINEL_B]);

  const credentialService = new ConnectorCredentialService({
    repository,
    cipher: createConnectorCredentialCipher(env),
    organizationId: ORGANIZATION_ID,
    env,
    clock: () => new Date(NOW),
  });
  await credentialService.rotate({
    connector: "sif",
    secret: SENTINEL_B,
    actorUserId: ADMIN_ID,
  });
  const modelInputs: unknown[] = [];
  const leakConnector = createSifConnector({
    resolveCredential: async () => (await credentialService.resolve("sif")).secret,
    fetchImpl: async (_input, init) => {
      const currentCredential = new Headers(init?.headers).get("secret-key");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify({ leaked: currentCredential }) }],
          },
        }),
        { status: 200 },
      );
    },
    policy: {
      timeoutMs: 100,
      maxAttempts: 1,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 1,
    },
  });
  await assert.rejects(
    async () => {
      const result = await leakConnector.execute({ operation: "test", input: {} });
      modelInputs.push(result.data);
    },
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "malformed-response",
  );
  assert.deepEqual(modelInputs, []);

  await new Promise<void>((resolve) => setImmediate(resolve));
  const database = new DatabaseSync(path, { readOnly: true });
  const persisted = JSON.stringify({
    credentials: database.prepare(
      "SELECT organization_id, connector, version, status, ciphertext, nonce, auth_tag, key_id, created_by, created_at, revoked_by, revoked_at FROM connector_credentials",
    ).all(),
    audits: database.prepare(
      "SELECT organization_id, action, target_type, target_id, actor_user_id, metadata_json, created_at FROM audit_events WHERE action LIKE 'connector.credential-%'",
    ).all(),
  });
  database.close();
  assert.doesNotMatch(
    `${responses.join("\n")}\n${logs}\n${persisted}\n${JSON.stringify(modelInputs)}`,
    new RegExp(`${SENTINEL_A}|${SENTINEL_B}`),
  );
});

async function seedUsersAndSessions(
  repository: ReturnType<typeof openSqliteAgentRepository>,
) {
  await repository.createInitialAdmin({
    id: ADMIN_ID,
    organizationId: ORGANIZATION_ID,
    email: "credential-admin@example.com",
    displayName: "Credential Admin",
    passwordHash: PASSWORD_RECORD,
    createdAt: NOW,
  });
  await repository.createUser({
    id: MEMBER_ID,
    organizationId: ORGANIZATION_ID,
    email: "credential-member@example.com",
    displayName: "Credential Member",
    role: "member",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  for (const [id, userId, token] of [
    [ADMIN_SESSION_ID, ADMIN_ID, ADMIN_TOKEN],
    [MEMBER_SESSION_ID, MEMBER_ID, MEMBER_TOKEN],
  ] as const) {
    await repository.createSession({
      id,
      userId,
      tokenHash: digestSessionToken(token),
      expiresAt: "2099-08-19T08:00:00.000Z",
      revokedAt: null,
      createdAt: NOW,
      lastSeenAt: null,
    });
  }
}

function sessionHeaders(token: string) {
  return {
    origin: ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    cookie: `__Host-agent_session=${token}`,
  };
}

async function putCredential(
  agent: Awaited<ReturnType<typeof createAgentService>>,
  secret: string,
) {
  const response = await agent.app.inject({
    method: "PUT",
    url: "/v1/connectors/sif/credential",
    headers: sessionHeaders(ADMIN_TOKEN),
    payload: { secret },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().configured, true);
  return response.body;
}

async function probe(
  agent: Awaited<ReturnType<typeof createAgentService>>,
  expectedAvailable = true,
) {
  const response = await agent.app.inject({
    method: "POST",
    url: "/v1/connectors/sif/probe",
    headers: sessionHeaders(ADMIN_TOKEN),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().configured, expectedAvailable);
  assert.equal(response.json().available, expectedAvailable);
  return response.body;
}
