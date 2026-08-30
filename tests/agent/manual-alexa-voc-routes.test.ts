import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import type { ManualAlexaVocService } from "../../server/services/manual-alexa-voc-service";
import { ManualAlexaVocRepositoryError } from "../../server/db/manual-alexa-voc-repository";
import { MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT } from "../../shared/agent-contracts";

const ORIGIN = "http://127.0.0.1:31900";
const PROXY_TOKEN = "manual-alexa-voc-proxy-token";
const MEMBER_TOKEN = "M".repeat(43);
const ADMIN_TOKEN = "A".repeat(43);
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const MEMBER_ID = "10000000-0000-4000-8000-000000000002";
const ADMIN_ID = "10000000-0000-4000-8000-000000000003";
const ASIN = "B0ALEXA001";
const RAW_TEXT = `${ASIN} — 顾客评价深度分析`;

const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: {
    name: "__Host-agent_session",
    secure: true,
    maxAgeSeconds: 28_800,
  },
  sessionTtlMs: 28_800_000,
  loginLimiter: {
    windowMs: 900_000,
    maxFailures: 5,
    maxEntries: 10_000,
  },
};

const normalizedRecord = {
  asin: ASIN,
  attention: ["安装"],
  positives: ["可靠"],
  negatives: ["包装"],
  unmet: [],
  audiences: [],
  scenarios: [],
  motives: [],
  captureStatus: "dialog" as const,
  alexaReport: {
    title: "顾客评价深度分析",
    asin: ASIN,
    rating: 0,
    reviewCount: 0,
    prompt: MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
    overallConclusion: "已录入",
    captureStatus: "dialog" as const,
  },
};

class FakeAuthService {
  async authenticate(token: string | null) {
    if (token === MEMBER_TOKEN) {
      return {
        kind: "user" as const,
        userId: MEMBER_ID,
        organizationId: ORGANIZATION_ID,
        email: "member@example.com",
        role: "member" as const,
        sessionId: "20000000-0000-4000-8000-000000000001",
      };
    }
    if (token === ADMIN_TOKEN) {
      return {
        kind: "user" as const,
        userId: ADMIN_ID,
        organizationId: ORGANIZATION_ID,
        email: "admin@example.com",
        role: "admin" as const,
        sessionId: "20000000-0000-4000-8000-000000000002",
      };
    }
    return null;
  }
}

function sessionHeaders(token = MEMBER_TOKEN) {
  return {
    origin: ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    cookie: `__Host-agent_session=${token}`,
  };
}

function appWithService(service: ManualAlexaVocService) {
  return buildAgentApp({
    env: {
      AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN,
      AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN,
    },
    authConfig,
    authService: new FakeAuthService() as unknown as AuthenticationService,
    manualAlexaVocService: service,
  });
}

function safeRecord(asin = ASIN) {
  return {
    asin,
    marketplace: "US" as const,
    revision: "1",
    normalizedRecord: {
      ...normalizedRecord,
      asin,
      alexaReport: { ...normalizedRecord.alexaReport, asin },
    },
    source: "postgres" as const,
    generation: "1",
    capturedAt: "2026-08-31T01:02:03.456Z",
  };
}

test("authorized member import returns the safe committed record with 201", async (t) => {
  const calls: unknown[] = [];
  const service = {
    async importReport(input: unknown) {
      calls.push(input);
      return {
        record: safeRecord(),
      };
    },
  } as unknown as ManualAlexaVocService;
  const app = appWithService(service);
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/manual-alexa-voc/import",
    headers: sessionHeaders(),
    payload: { asin: ASIN, marketplace: "US", rawText: RAW_TEXT },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().record.revision, "1");
  assert.equal(response.json().record.normalizedRecord.alexaReport.asin, ASIN);
  assert.doesNotMatch(response.body, /rawText|organizationId|createdBy/);
  assert.deepEqual(calls, [{
    principal: { organizationId: ORGANIZATION_ID, userId: MEMBER_ID },
    request: { asin: ASIN, marketplace: "US", rawText: RAW_TEXT },
  }]);
});

test("manual routes require proxy token, trusted Origin, and a valid member or admin session", async (t) => {
  const accepted: string[] = [];
  const service = {
    async importReport(input: { principal: { userId: string } }) {
      accepted.push(input.principal.userId);
      return { record: safeRecord() };
    },
  } as unknown as ManualAlexaVocService;
  const app = appWithService(service);
  t.after(() => app.close());
  const payload = { asin: ASIN, marketplace: "US", rawText: RAW_TEXT };

  const responses = await Promise.all([
    app.inject({ method: "POST", url: "/v1/manual-alexa-voc/import", headers: { origin: ORIGIN, cookie: `__Host-agent_session=${MEMBER_TOKEN}` }, payload }),
    app.inject({ method: "POST", url: "/v1/manual-alexa-voc/import", headers: { "x-agent-proxy-token": PROXY_TOKEN, cookie: `__Host-agent_session=${MEMBER_TOKEN}` }, payload }),
    app.inject({ method: "POST", url: "/v1/manual-alexa-voc/import", headers: { origin: ORIGIN, "x-agent-proxy-token": PROXY_TOKEN }, payload }),
    app.inject({ method: "POST", url: "/v1/manual-alexa-voc/import", headers: sessionHeaders("Z".repeat(43)), payload }),
    app.inject({ method: "POST", url: "/v1/manual-alexa-voc/import", headers: sessionHeaders(MEMBER_TOKEN), payload }),
    app.inject({ method: "POST", url: "/v1/manual-alexa-voc/import", headers: sessionHeaders(ADMIN_TOKEN), payload }),
  ]);

  assert.deepEqual(responses.map(response => response.statusCode), [401, 403, 401, 401, 201, 201]);
  assert.deepEqual(accepted.sort(), [ADMIN_ID, MEMBER_ID].sort());
});

test("import accepts exactly one compatible text field and validates before calling the service", async (t) => {
  const calls: unknown[] = [];
  const service = {
    async importReport(input: { request: unknown }) {
      calls.push(input.request);
      return { record: safeRecord() };
    },
  } as unknown as ManualAlexaVocService;
  const app = appWithService(service);
  t.after(() => app.close());

  const legacy = await app.inject({
    method: "POST",
    url: "/v1/manual-alexa-voc/import",
    headers: sessionHeaders(),
    payload: { asin: ASIN, marketplace: "US", text: RAW_TEXT },
  });
  const both = await app.inject({
    method: "POST",
    url: "/v1/manual-alexa-voc/import",
    headers: sessionHeaders(),
    payload: { asin: ASIN, marketplace: "US", text: RAW_TEXT, rawText: RAW_TEXT },
  });

  assert.equal(legacy.statusCode, 201);
  assert.equal(both.statusCode, 400);
  assert.deepEqual(calls, [{ asin: ASIN, marketplace: "US", rawText: RAW_TEXT }]);
});

test("list parses a bounded unique US ASIN query and returns the available subset only", async (t) => {
  const missingAsin = "B07VY9Q95Q";
  const calls: unknown[] = [];
  const service = {
    async listReports(input: unknown) {
      calls.push(input);
      return { records: [safeRecord()] };
    },
  } as unknown as ManualAlexaVocService;
  const app = appWithService(service);
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/manual-alexa-voc?marketplace=US&asins=${ASIN}&asins=${missingAsin}`,
    headers: sessionHeaders(),
  });
  const duplicate = await app.inject({
    method: "GET",
    url: `/v1/manual-alexa-voc?marketplace=US&asins=${ASIN}&asins=${ASIN}`,
    headers: sessionHeaders(),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().records.map((record: { asin: string }) => record.asin), [ASIN]);
  assert.equal(duplicate.statusCode, 400);
  assert.deepEqual(calls, [{
    principal: { organizationId: ORGANIZATION_ID, userId: MEMBER_ID },
    query: { marketplace: "US", asins: [ASIN, missingAsin] },
  }]);
});

test("missing storage and typed repository failures return distinct safe 503 errors", async (t) => {
  const missing = appWithService(null as unknown as ManualAlexaVocService);
  const failing = appWithService({
    async importReport() {
      throw new ManualAlexaVocRepositoryError("connection", {
        cause: new Error("postgres://secret-user:secret-password@internal/manual-voc"),
      });
    },
  } as unknown as ManualAlexaVocService);
  t.after(async () => {
    await missing.close();
    await failing.close();
  });
  const request = {
    method: "POST" as const,
    url: "/v1/manual-alexa-voc/import",
    headers: sessionHeaders(),
    payload: { asin: ASIN, marketplace: "US", rawText: RAW_TEXT },
  };

  const missingResponse = await missing.inject(request);
  const failingResponse = await failing.inject(request);

  assert.equal(missingResponse.statusCode, 503);
  assert.equal(missingResponse.json().error.code, "CONFIGURATION_ERROR");
  assert.equal(failingResponse.statusCode, 503);
  assert.equal(failingResponse.json().error.code, "INFRASTRUCTURE_ERROR");
  assert.doesNotMatch(failingResponse.body, /postgres|secret-user|secret-password|internal/i);
});
