import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";

import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import { buildAgentApp } from "../../server/app";
import {
  ImmutableProjectScopeError,
  LegacyProjectOwnerBindingError,
  ProjectCreationIdempotencyConflictError,
  type AgentRepository,
  type ComparisonProjectRepository,
  type CreateProjectInput,
  type RuntimeAgentRepository,
} from "../../server/db/repository";
import { PostgresAgentRepository } from "../../server/db/postgres-repository";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const now = "2026-08-31T08:00:00.000Z";
const later = "2026-08-31T08:01:00.000Z";
const organizationA = "91000000-0000-4000-8000-000000000001";
const organizationB = "91000000-0000-4000-8000-000000000002";
const operatorA = "91000000-0000-4000-8000-000000000003";
const memberA = "91000000-0000-4000-8000-000000000004";
const disabledA = "91000000-0000-4000-8000-000000000005";
const memberB = "91000000-0000-4000-8000-000000000006";
const projectA = "91000000-0000-4000-8000-000000000007";
const replayProjectA = "91000000-0000-4000-8000-000000000008";
const projectB = "91000000-0000-4000-8000-000000000009";
const idempotencyKey = "comparison.project:0001";
const asins = ["B0AAAA0001", "B0BBBB0002", "B0CCCC0003"];
const proxyToken = "comparison-project-proxy-token";
const trustedOrigin = "http://127.0.0.1:3001";
const rawToken = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const securityEnv = {
  AGENT_SERVICE_PROXY_TOKEN: proxyToken,
  AGENT_SERVICE_TRUSTED_ORIGINS: trustedOrigin,
};
const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: { name: "__Host-agent_session", secure: true, maxAgeSeconds: 28_800 },
  sessionTtlMs: 28_800_000,
  loginLimiter: { windowMs: 900_000, maxFailures: 5, maxEntries: 10_000 },
};

type ComparisonRepository = AgentRepository & ComparisonProjectRepository;

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

test("SQLite comparison project repository is tenant-scoped, idempotent, and immutable", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "comparison-project-sqlite-"));
  const path = join(directory, "agent.sqlite");
  let repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await exerciseComparisonProjectRepository(t, repository, async () => {
    repository.close();
    repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    return repository;
  });
});

test("PostgreSQL comparison project repository is tenant-scoped, idempotent, and immutable", async (t) => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  let pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  let repository = new PostgresAgentRepository(pool);
  t.after(async () => {
    await repository.close();
  });

  await exerciseComparisonProjectRepository(t, repository, async () => {
    await repository.close();
    pool = postgres.createPool({ searchPath: schema });
    repository = new PostgresAgentRepository(pool);
    return repository;
  });
});

test("principal-scoped project routes enforce header idempotency, tenant reads, and immutable project patch", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "comparison-project-routes-"));
  const path = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedUsers(repository);
  const appA = buildAgentApp({
    env: securityEnv,
    repository: repository as unknown as RuntimeAgentRepository,
    authConfig,
    authService: asAuthService(new FakeAuthService(principal(memberA, organizationA, "member"))),
  });
  const appB = buildAgentApp({
    env: securityEnv,
    repository: repository as unknown as RuntimeAgentRepository,
    authConfig,
    authService: asAuthService(new FakeAuthService(principal(memberB, organizationB, "member"))),
  });
  t.after(async () => {
    await appA.close();
    await appB.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const payload = { name: "Principal comparison", marketplace: "US", asins };
  const missingKey = await appA.inject({
    method: "POST",
    url: "/v1/projects",
    headers: sessionHeaders(),
    payload,
  });
  assert.equal(missingKey.statusCode, 400);
  assert.equal(missingKey.json().error.code, "VALIDATION_ERROR");

  const malformedKey = await appA.inject({
    method: "POST",
    url: "/v1/projects",
    headers: sessionHeaders({ "idempotency-key": "not valid" }),
    payload,
  });
  assert.equal(malformedKey.statusCode, 400);
  assert.equal((await repository.listProjectsByOrganization(organizationA)).length, 0);

  const created = await appA.inject({
    method: "POST",
    url: "/v1/projects",
    headers: sessionHeaders({ "idempotency-key": idempotencyKey }),
    payload,
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().project.organizationId, organizationA);
  assert.equal(created.json().project.createdBy, memberA);
  const createdProjectId = created.json().project.id as string;

  const replayed = await appA.inject({
    method: "POST",
    url: "/v1/projects",
    headers: sessionHeaders({ "idempotency-key": idempotencyKey }),
    payload,
  });
  assert.equal(replayed.statusCode, 200);
  assert.equal(replayed.json().project.id, createdProjectId);

  const listed = await appA.inject({
    method: "GET",
    url: "/v1/projects",
    headers: sessionHeaders(),
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().projects.map((project: { id: string }) => project.id), [createdProjectId]);

  const foreignRead = await appB.inject({
    method: "GET",
    url: `/v1/projects/${createdProjectId}`,
    headers: sessionHeaders(),
  });
  assert.equal(foreignRead.statusCode, 404);
  assert.equal(foreignRead.json().error.code, "NOT_FOUND");

  const renamed = await appA.inject({
    method: "PATCH",
    url: `/v1/projects/${createdProjectId}`,
    headers: sessionHeaders(),
    payload: { name: "Renamed by principal" },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().project.name, "Renamed by principal");

  for (const scopePatch of [{ marketplace: "US" }, { asins }]) {
    const immutable = await appA.inject({
      method: "PATCH",
      url: `/v1/projects/${createdProjectId}`,
      headers: sessionHeaders(),
      payload: scopePatch,
    });
    assert.equal(immutable.statusCode, 409);
    assert.equal(immutable.json().error.code, "IMMUTABLE_SCOPE");
  }

  for (const malformedPatch of [
    { marketplace: "CA" },
    { asins: ["bad"] },
    { unknown: "field" },
  ]) {
    const malformed = await appA.inject({
      method: "PATCH",
      url: `/v1/projects/${createdProjectId}`,
      headers: sessionHeaders(),
      payload: malformedPatch,
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, "VALIDATION_ERROR");
  }
});

test("legacy owner binding is available only through the authenticated operator route", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "comparison-project-legacy-route-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  await seedUsers(repository);
  const memberApp = buildAgentApp({
    env: securityEnv,
    repository: repository as unknown as RuntimeAgentRepository,
    authConfig,
    authService: asAuthService(new FakeAuthService(principal(memberA, organizationA, "member"))),
  });
  const operatorApp = buildAgentApp({
    env: securityEnv,
    repository: repository as unknown as RuntimeAgentRepository,
    authConfig,
    authService: asAuthService(new FakeAuthService(principal(operatorA, organizationA, "admin"))),
  });
  t.after(async () => {
    await memberApp.close();
    await operatorApp.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const url = "/v1/admin/legacy-project-ownership/legacy-project-one";
  const denied = await memberApp.inject({
    method: "POST",
    url,
    headers: sessionHeaders(),
    payload: { ownerUserId: memberA },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(await repository.findLegacyProjectOwnerBinding("legacy-project-one"), null);

  const created = await operatorApp.inject({
    method: "POST",
    url,
    headers: sessionHeaders(),
    payload: { ownerUserId: memberA },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().binding.ownerUserId, memberA);
  const replayed = await operatorApp.inject({
    method: "POST",
    url,
    headers: sessionHeaders(),
    payload: { ownerUserId: memberA },
  });
  assert.equal(replayed.statusCode, 200);
});

test("legacy eligibility is principal-scoped and visitor reads never bind ownership", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "comparison-project-legacy-read-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  await seedUsers(repository);
  const ownedLegacyId = "91000000-0000-4000-8000-000000000010";
  const foreignLegacyId = "91000000-0000-4000-8000-000000000011";
  const boundLegacyId = "91000000-0000-4000-8000-000000000012";
  const unownedLegacyId = "91000000-0000-4000-8000-000000000013";
  const legacyProjects = new Map([
    [ownedLegacyId, { id: ownedLegacyId, createdBy: memberA }],
    [foreignLegacyId, { id: foreignLegacyId, createdBy: memberB }],
    [boundLegacyId, { id: boundLegacyId, createdBy: null }],
    [unownedLegacyId, { id: unownedLegacyId, createdBy: null }],
  ]);
  await repository.bindLegacyProjectOwnerOnce({
    legacyProjectId: boundLegacyId,
    organizationId: organizationA,
    ownerUserId: memberA,
    operatorUserId: operatorA,
    boundAt: now,
  });
  let reads = 0;
  const app = buildAgentApp({
    env: securityEnv,
    repository: repository as unknown as RuntimeAgentRepository,
    authConfig,
    authService: asAuthService(new FakeAuthService(principal(memberA, organizationA, "member"))),
    readLegacyProject: (id) => {
      reads += 1;
      return legacyProjects.get(id) ?? null;
    },
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  for (const legacyProjectId of [ownedLegacyId, boundLegacyId]) {
    const eligible = await app.inject({
      method: "GET",
      url: `/v1/legacy-projects/${legacyProjectId}/eligibility`,
      headers: sessionHeaders(),
    });
    assert.equal(eligible.statusCode, 200);
    assert.deepEqual(eligible.json(), {
      legacyProjectId,
      ownerOrganizationId: organizationA,
      readOnly: true,
      importAllowed: true,
    });
  }
  for (const legacyProjectId of [foreignLegacyId, unownedLegacyId]) {
    const hidden = await app.inject({
      method: "GET",
      url: `/v1/legacy-projects/${legacyProjectId}/eligibility`,
      headers: sessionHeaders(),
    });
    assert.equal(hidden.statusCode, 404);
    assert.equal(hidden.json().error.code, "NOT_FOUND");
    assert.equal(await repository.findLegacyProjectOwnerBinding(legacyProjectId), null);
  }
  assert.equal(reads, 4);
});

async function exerciseComparisonProjectRepository(
  _t: TestContext,
  initialRepository: ComparisonRepository,
  reopen: () => Promise<ComparisonRepository>,
): Promise<void> {
  let repository = initialRepository;
  await seedUsers(repository);

  await assert.rejects(
    async () => repository.createProjectOnce({
      idempotencyKey: "short",
      project: projectInput(projectA, organizationA, memberA),
    }),
    TypeError,
  );
  assert.equal(await repository.findProjectById(projectA), null);

  const created = await repository.createProjectOnce({
    idempotencyKey,
    project: projectInput(projectA, organizationA, memberA),
  });
  assert.equal(created.created, true);
  assert.equal(created.project.id, projectA);

  repository = await reopen();
  const replayed = await repository.createProjectOnce({
    idempotencyKey,
    project: projectInput(replayProjectA, organizationA, memberA),
  });
  assert.equal(replayed.created, false);
  assert.equal(replayed.project.id, projectA);
  assert.deepEqual(replayed.project.asins, asins);

  await assert.rejects(
    repository.createProjectOnce({
      idempotencyKey,
      project: { ...projectInput(replayProjectA, organizationA, memberA), name: "Changed payload" },
    }),
    ProjectCreationIdempotencyConflictError,
  );

  const isolated = await repository.createProjectOnce({
    idempotencyKey,
    project: projectInput(projectB, organizationB, memberB),
  });
  assert.equal(isolated.created, true);
  assert.equal(isolated.project.organizationId, organizationB);

  await assert.rejects(
    repository.updateProjectMetadata({
      organizationId: organizationA,
      projectId: projectA,
      marketplace: "US",
      updatedAt: later,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ImmutableProjectScopeError);
      assert.equal(error.code, "IMMUTABLE_SCOPE");
      return true;
    },
  );
  await assert.rejects(
    repository.updateProjectMetadata({
      organizationId: organizationA,
      projectId: projectA,
      asins: [...asins].reverse(),
      updatedAt: later,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ImmutableProjectScopeError);
      assert.equal(error.code, "IMMUTABLE_SCOPE");
      return true;
    },
  );

  const renamed = await repository.updateProjectMetadata({
    organizationId: organizationA,
    projectId: projectA,
    name: "Renamed comparison",
    updatedAt: later,
  });
  assert.equal(renamed?.name, "Renamed comparison");
  assert.deepEqual(renamed?.asins, asins);

  const bound = await repository.bindLegacyProjectOwnerOnce({
    legacyProjectId: "legacy-project-one",
    organizationId: organizationA,
    ownerUserId: memberA,
    operatorUserId: operatorA,
    boundAt: now,
  });
  assert.equal(bound.created, true);
  const rebound = await repository.bindLegacyProjectOwnerOnce({
    legacyProjectId: "legacy-project-one",
    organizationId: organizationA,
    ownerUserId: memberA,
    operatorUserId: operatorA,
    boundAt: later,
  });
  assert.equal(rebound.created, false);
  assert.deepEqual(await repository.findLegacyProjectOwnerBinding("legacy-project-one"), bound.binding);

  await assert.rejects(
    repository.bindLegacyProjectOwnerOnce({
      legacyProjectId: "legacy-disabled-owner",
      organizationId: organizationA,
      ownerUserId: disabledA,
      operatorUserId: operatorA,
      boundAt: now,
    }),
    LegacyProjectOwnerBindingError,
  );
}

async function seedUsers(repository: ComparisonRepository): Promise<void> {
  await repository.createUser({
    id: operatorA,
    organizationId: organizationA,
    email: "operator-a@example.test",
    displayName: "Operator A",
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createUser({
    id: memberA,
    organizationId: organizationA,
    email: "member-a@example.test",
    displayName: "Member A",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createUser({
    id: disabledA,
    organizationId: organizationA,
    email: "disabled-a@example.test",
    displayName: "Disabled A",
    role: "member",
    status: "disabled",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createUser({
    id: memberB,
    organizationId: organizationB,
    email: "member-b@example.test",
    displayName: "Member B",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

function projectInput(
  id: string,
  organizationId: string,
  createdBy: string,
): CreateProjectInput {
  return {
    id,
    organizationId,
    name: "Comparison project",
    marketplace: "US",
    asins: [...asins],
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

class FakeAuthService {
  constructor(
    readonly authenticated: Awaited<ReturnType<AuthenticationService["authenticate"]>>,
  ) {}

  async authenticate(token: string | null) {
    return token === rawToken ? this.authenticated : null;
  }
}

function asAuthService(service: FakeAuthService): AuthenticationService {
  return service as unknown as AuthenticationService;
}

function principal(
  userId: string,
  organizationId: string,
  role: "admin" | "member",
) {
  return {
    kind: "user" as const,
    userId,
    organizationId,
    email: `${role}@example.test`,
    role,
    sessionId: "91000000-0000-4000-8000-000000000099",
  };
}

function sessionHeaders(overrides: Record<string, string> = {}) {
  return {
    origin: trustedOrigin,
    "x-agent-proxy-token": proxyToken,
    cookie: `__Host-agent_session=${rawToken}`,
    ...overrides,
  };
}
