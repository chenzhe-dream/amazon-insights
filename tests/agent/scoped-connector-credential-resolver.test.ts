import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAgentService } from "../../server/agent-service";
import { openRuntimeAgentRepository } from "../../server/db/open-runtime-repository";
import type { MarketResearchRepository } from "../../server/db/market-research-repository";
import { createConnectorCredentialCipher } from "../../server/security/connector-credential-cipher";
import { ConnectorCredentialService } from "../../server/services/connector-credential-service";
import { createScopedConnectorCredentialResolver } from "../../server/services/scoped-connector-credential-resolver";
import { ConnectorError } from "../../server/connectors/connector-contract";

test("request organization wins over execution fallback and each call resolves its own organization", async () => {
  const calls: string[] = [];
  const resolve = createScopedConnectorCredentialResolver({ env: { SIF_MCP_SECRET: "unused-environment" }, executionOrganizationId: "execution-org",
    serviceForOrganization: organizationId => ({ resolve: async connectorId => {
      calls.push(`${organizationId}:${connectorId}`);
      return { secret: `${organizationId}-managed` };
    } }),
  });
  assert.equal(await resolve("sif", { organizationId: "request-org-a" }), "request-org-a-managed");
  assert.equal(await resolve("sif", { organizationId: "request-org-b" }), "request-org-b-managed");
  assert.equal(await resolve("sorftime"), "execution-org-managed");
  assert.deepEqual(calls, ["request-org-a:sif", "request-org-b:sif", "execution-org:sorftime"]);
});

test("unscoped calls without execution identity preserve environment defaults and never resolve an empty organization", async () => {
  const resolve = createScopedConnectorCredentialResolver({ env: { SIF_MCP_SECRET: "  fixture-env  ", SELLERSPRITE_SECRET_KEY: " " }, executionOrganizationId: null,
    serviceForOrganization: () => { throw new Error("Unscoped requests must not access organization credentials"); },
  });
  assert.equal(await resolve("sif"), "fixture-env");
  assert.equal(await resolve("sorftime"), null);
  assert.equal(await resolve("sellerSprite"), null);
  await assert.rejects(resolve("sif", { organizationId: " " }), ConnectorError);
});

test("an organization credential failure never falls back to the global environment secret", async () => {
  const failure = new Error("fixture decryption failure");
  const resolve = createScopedConnectorCredentialResolver({ env: { SELLERSPRITE_SECRET_KEY: "must-not-be-used" },
    serviceForOrganization: () => ({ resolve: async () => { throw failure; } }),
  });
  await assert.rejects(resolve("sellerSprite", { organizationId: "request-org" }), error => error === failure);
});

test("market worker without an AI execution identity uses its organization's managed credential", { timeout: 10_000 }, async t => {
  const organizationId = randomUUID(), userId = randomUUID(), id = randomUUID();
  const now = "2026-09-12T00:00:00.000Z";
  const env = {
    NODE_ENV: "test", AGENT_SERVICE_PROXY_TOKEN: "fixture-market-proxy-token",
    AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
    AGENT_CONNECTOR_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 0x61).toString("base64url"),
    SELLERSPRITE_SECRET_KEY: "fixture-environment-credential",
  };
  const repository = await openRuntimeAgentRepository({ kind: "sqlite", sqlite: { path: ":memory:", busyTimeoutMs: 5_000 } });
  let agent: Awaited<ReturnType<typeof createAgentService>> | null = null;
  t.after(async () => { await agent?.stop(); await repository.close(); });
  await repository.createInitialAdmin({ id: userId, organizationId, email: `${userId}@example.com`, displayName: "Fixture", createdAt: now,
    passwordHash: "scrypt-v1$16384$8$1$YWdlbnQtYXV0aC1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
  const credentials = new ConnectorCredentialService({ repository, organizationId, env,
    cipher: createConnectorCredentialCipher(env), clock: () => new Date(now) });
  await credentials.rotate({ connector: "sellerSprite", secret: "fixture-managed-credential", actorUserId: userId });
  let claimed = false;
  const marketResearch: MarketResearchRepository = {
    create: async () => { throw new Error("unused fixture method"); }, find: async () => null, list: async () => [], retry: async () => null,
    claim: async ({ ownerId }) => {
      if (claimed) return null; claimed = true;
      return { organizationId, userId, ownerId, generation: 1, job: { id, status: "running", attempts: 1, createdAt: now, updatedAt: now, report: null, error: null,
        scope: { marketplace: "US", nodeQuery: "228013:1063278", month: "2026-08", headTopN: 10, newProductMonths: 3 } } };
    }, renew: async () => true, finish: async () => true,
  };
  let observed!: (secret: string | null) => void;
  const firstCredential = new Promise<string | null>(resolve => { observed = resolve; });
  agent = await createAgentService({ repository: Object.assign(repository, { marketResearch }), env, logger: false, clock: () => new Date(now),
    connectorFetchImpl: async (_input, init) => {
      observed(new Headers(init?.headers).get("secret-key"));
      throw new Error("Fixture transport stops before contacting an upstream server");
    },
  });
  await agent.start({ host: "127.0.0.1", port: 0 });
  assert.equal(await firstCredential, "fixture-managed-credential");
});
