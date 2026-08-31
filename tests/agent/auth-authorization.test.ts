import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRoute,
  requireRole,
  type RequestPrincipal,
} from "../../server/auth/authorization";

const MEMBER: RequestPrincipal = {
  kind: "user",
  userId: "10000000-0000-4000-8000-000000000001",
  organizationId: "10000000-0000-4000-8000-000000000002",
  email: "member@example.com",
  role: "member",
  sessionId: "10000000-0000-4000-8000-000000000003",
};
const ADMIN: RequestPrincipal = { ...MEMBER, role: "admin" };
const ANONYMOUS: RequestPrincipal = { kind: "anonymous-loopback" };

const fixtureAllowlist = [
  ["POST", "/v1/local-voc"],
  ["POST", "/v1/runs/00000000-0000-4000-8000-000000000001/voc-import"],
  ["GET", "/v1/runs/00000000-0000-4000-8000-000000000001"],
  ["GET", "/v1/runs/00000000-0000-4000-8000-000000000001/reports"],
  ["GET", "/v1/reports/00000000-0000-4000-8000-000000000001"],
  ["GET", "/v1/local-data/fixture"],
] as const;

test("route classification is closed and method-exact", () => {
  assert.deepEqual(classifyRoute("GET", "/health"), { kind: "public" });
  assert.deepEqual(classifyRoute("POST", "/health"), {
    kind: "session",
    roles: ["admin", "member"],
  });

  for (const [method, path] of [
    ["POST", "/v1/auth/login"],
    ["POST", "/v1/auth/logout"],
    ["GET", "/v1/auth/session"],
  ] as const) {
    assert.deepEqual(classifyRoute(method, path), { kind: "proxy-only" });
  }
  assert.equal(classifyRoute("GET", "/v1/auth/login").kind, "session");

  assert.deepEqual(classifyRoute("GET", "/v1/admin/users"), {
    kind: "session",
    roles: ["admin"],
  });
  assert.deepEqual(classifyRoute("POST", "/v1/auth/activity"), {
    kind: "session",
    roles: ["admin", "member"],
  });

  assert.deepEqual(classifyRoute("GET", "/v1/capabilities"), {
    kind: "session-or-anonymous-loopback",
    roles: ["admin", "member"],
  });
  assert.deepEqual(classifyRoute("GET", "/v1/readiness"), {
    kind: "proxy-only",
  });
  for (const [method, path] of [
    ["POST", "/v1/capabilities"],
    ["GET", "/v1/capabilities/extra"],
    ["POST", "/v1/readiness"],
    ["GET", "/v1/readiness/extra"],
  ] as const) {
    assert.deepEqual(classifyRoute(method, path), {
      kind: "session",
      roles: ["admin", "member"],
    });
  }

  for (const [method, path] of [
    ["POST", "/v1/feedback"],
    ["GET", "/v1/feedback/mine"],
    ["GET", "/v1/feedback/mine/40000000-0000-4000-8000-000000000001"],
    [
      "GET",
      "/v1/feedback/mine/40000000-0000-4000-8000-000000000001/attachments/50000000-0000-4000-8000-000000000001",
    ],
    ["GET", "/v1/feedback/admin"],
    ["GET", "/v1/feedback/admin/unread-count"],
    ["GET", "/v1/feedback/admin/40000000-0000-4000-8000-000000000001"],
    [
      "GET",
      "/v1/feedback/admin/40000000-0000-4000-8000-000000000001/attachments/50000000-0000-4000-8000-000000000001",
    ],
    ["POST", "/v1/feedback/admin/40000000-0000-4000-8000-000000000001/mark-seen"],
    ["POST", "/v1/feedback/admin/40000000-0000-4000-8000-000000000001/status"],
  ] as const) {
    assert.deepEqual(classifyRoute(method, path), {
      kind: "session",
      roles: path.startsWith("/v1/feedback/admin")
        ? ["admin"]
        : ["admin", "member"],
    });
  }

  for (const [method, path] of fixtureAllowlist) {
    assert.deepEqual(classifyRoute(method, path), {
      kind: "session-or-anonymous-loopback",
      roles: ["admin", "member"],
    });
  }

  assert.deepEqual(classifyRoute("GET", "/v1/local-data/projects"), {
    kind: "session",
    roles: ["admin", "member"],
  });
  assert.deepEqual(classifyRoute("POST", "/v1/local-data/projects"), {
    kind: "session",
    roles: ["admin", "member"],
  });
  assert.deepEqual(classifyRoute("PATCH", "/v1/local-data/projects/project-1"), {
    kind: "session",
    roles: ["admin", "member"],
  });
  assert.deepEqual(classifyRoute("DELETE", "/v1/local-data/projects/project-1"), {
    kind: "session",
    roles: ["admin", "member"],
  });
  assert.deepEqual(classifyRoute("GET", "/v1/local-data/sync-asins"), {
    kind: "session",
    roles: ["admin", "member"],
  });
  assert.deepEqual(classifyRoute("POST", "/v1/local-data/sync-asins"), {
    kind: "session",
    roles: ["admin", "member"],
  });
  assert.deepEqual(classifyRoute("GET", "/v1/local-data/sync-asins/job-1"), {
    kind: "session",
    roles: ["admin", "member"],
  });
  assert.deepEqual(
    classifyRoute(
      "GET",
      "/v1/projects/10000000-0000-4000-8000-000000000001/runs/10000000-0000-4000-8000-000000000002/sync-jobs/job-1/stages/sales_trend/output",
    ),
    { kind: "session", roles: ["admin", "member"] },
  );
  assert.deepEqual(classifyRoute("POST", "/v1/admin/sync-asins/job-1/resume"), {
    kind: "session",
    roles: ["admin"],
  });
  assert.equal(classifyRoute("PUT", "/v1/local-data/projects/project-1").kind, "session");

  assert.deepEqual(classifyRoute("POST", "/v1/connectors/sif/probe"), {
    kind: "session",
    roles: ["admin"],
  });
  for (const [method, path] of [
    ["GET", "/v1/connectors"],
    ["PUT", "/v1/connectors/sif/credential"],
    ["DELETE", "/v1/connectors/sif/credential"],
  ] as const) {
    assert.deepEqual(classifyRoute(method, path), {
      kind: "session",
      roles: ["admin"],
    });
  }
  assert.equal(
    classifyRoute("GET", "/v1/connectors/sif/probe").kind,
    "session",
  );

  for (const [method, path] of [
    ["POST", "/v1/runs/00000000-0000-4000-8000-000000000001/cancel"],
    ["POST", "/v1/projects/00000000-0000-4000-8000-000000000001/runs"],
    ["GET", "/v1/internal/secrets"],
    ["GET", "/v1/runs/not-a-uuid"],
  ] as const) {
    assert.deepEqual(classifyRoute(method, path), {
      kind: "session",
      roles: ["admin", "member"],
    });
  }
});

test("anonymous allowlist is exact and anchored", () => {
  for (const [method, path] of [
    ["GET", "/v1/local-voc"],
    ["POST", "/v1/local-voc/extra"],
    ["GET", "/v1/runs/00000000-0000-4000-8000-000000000001/voc-import"],
    ["GET", "/v1/runs/00000000-0000-4000-8000-000000000001/reports/extra"],
    ["GET", "/v1/reports/00000000-0000-4000-8000-000000000001/extra"],
    ["POST", "/v1/local-data/fixture"],
    ["GET", "/v1/local-data/projects"],
    ["POST", "/v1/local-data/projects"],
    ["PATCH", "/v1/local-data/projects/project-1"],
    ["DELETE", "/v1/local-data/projects/project-1"],
    ["GET", "/v1/local-data/sync-asins"],
    ["POST", "/v1/local-data/sync-asins"],
    ["GET", "/v1/local-data/sync-asins/job-1"],
    ["GET", "/v1/local-data/fixture/extra"],
    ["GET", "/v1/local-data/unknown"],
    ["GET", "/v1/capabilities/extra"],
    ["POST", "/v1/connectors/sif/probe"],
  ] as const) {
    assert.notEqual(
      classifyRoute(method, path).kind,
      "session-or-anonymous-loopback",
      `${method} ${path}`,
    );
  }
});

test("role checks reject anonymous loopback and member-only misses", () => {
  assert.doesNotThrow(() => requireRole(ADMIN, ["admin"]));
  assert.doesNotThrow(() => requireRole(MEMBER, ["admin", "member"]));
  assert.throws(() => requireRole(MEMBER, ["admin"]), /Forbidden/);
  assert.throws(() => requireRole(ANONYMOUS, ["admin", "member"]), /Forbidden/);
});
