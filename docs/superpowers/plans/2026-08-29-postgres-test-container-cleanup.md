# PostgreSQL Test Container Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure this repository's temporary PostgreSQL test containers and anonymous data volumes are removed after tests instead of accumulating in Docker Desktop.

**Architecture:** Extract Docker run/remove argument construction into pure functions in the existing PostgreSQL test helper. The helper will create auto-removing, project-labeled containers and will explicitly remove anonymous volumes on both normal close and startup rollback.

**Tech Stack:** TypeScript, Node test runner, tsx, Docker, PostgreSQL 16 Alpine

## Global Constraints

- Modify only `C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/stabilize-resumable-sync-pipeline`.
- Do not run global Docker prune commands or remove resources belonging to other projects.
- Do not modify or remove `amazon-insights-postgres-cutover` or `amazon-insights-postgres-cutover-data`.
- Preserve the existing `PostgresTestContainer` public interface.
- Existing unrelated working-tree changes remain untouched.

---

### Task 1: Harden temporary PostgreSQL container lifecycle

**Files:**
- Modify: `tests/agent/helpers/postgres-test-container.ts:1-130`
- Create: `tests/agent/postgres-test-container-lifecycle.test.ts`

**Interfaces:**
- Consumes: safe generated container names, database names, and validated 64-character Docker container IDs.
- Produces: `postgresTestContainerRunArgs(input)` and `postgresTestContainerRemoveArgs(containerId)` plus the unchanged `startPostgresTestContainer()` API.

- [ ] **Step 1: Write failing parameter tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  postgresTestContainerRemoveArgs,
  postgresTestContainerRunArgs,
} from "./helpers/postgres-test-container";

test("PostgreSQL test containers auto-remove and carry the project label", () => {
  const args = postgresTestContainerRunArgs({
    containerName: "agent_pg_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    database: "agent_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });

  assert.equal(args.includes("--rm"), true);
  assert.deepEqual(
    args.slice(args.indexOf("--label"), args.indexOf("--label") + 2),
    ["--label", "com.amazon-insights.test-postgres=true"],
  );
});

test("PostgreSQL test cleanup force-removes anonymous volumes", () => {
  const id = "a".repeat(64);
  assert.deepEqual(postgresTestContainerRemoveArgs(id), [
    "rm",
    "--force",
    "--volumes",
    id,
  ]);
  assert.throws(() => postgresTestContainerRemoveArgs("unsafe"), /container ID/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/postgres-test-container-lifecycle.test.ts`

Expected: FAIL because the two Docker argument functions are not exported.

- [ ] **Step 3: Implement argument builders and wire both cleanup paths**

Add the fixed label and pure functions to `tests/agent/helpers/postgres-test-container.ts`:

```ts
const POSTGRES_TEST_CONTAINER_LABEL = "com.amazon-insights.test-postgres=true";

export function postgresTestContainerRunArgs(input: Readonly<{
  containerName: string;
  database: string;
}>): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    "--label",
    POSTGRES_TEST_CONTAINER_LABEL,
    "--name",
    input.containerName,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    `POSTGRES_DB=${input.database}`,
    POSTGRES_IMAGE,
  ];
}

export function postgresTestContainerRemoveArgs(containerId: string): string[] {
  if (!CONTAINER_ID_PATTERN.test(containerId)) {
    throw new Error("PostgreSQL test container ID is invalid");
  }
  return ["rm", "--force", "--volumes", containerId];
}
```

Replace the inline `docker run` array with:

```ts
containerId = await runDocker(postgresTestContainerRunArgs({ containerName, database }));
```

Replace both `runDocker(["rm", "--force", containerId])` calls with:

```ts
await runDocker(postgresTestContainerRemoveArgs(containerId));
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/postgres-test-container-lifecycle.test.ts`

Expected: two tests PASS.

- [ ] **Step 5: Add a real Docker lifecycle regression**

Extend `tests/agent/postgres-test-container-lifecycle.test.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startPostgresTestContainer } from "./helpers/postgres-test-container";

const execFileAsync = promisify(execFile);

async function dockerLines(args: string[]): Promise<string[]> {
  const result = await execFileAsync("docker", args, { encoding: "utf8", windowsHide: true });
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

test("closing a PostgreSQL test container leaves no container or anonymous volume", async () => {
  const containersBefore = new Set(await dockerLines(["ps", "-a", "--filter", "label=com.amazon-insights.test-postgres=true", "--format", "{{.ID}}"]));
  const postgres = await startPostgresTestContainer();
  let containerId = "";
  let volumeName = "";
  try {
    const containersDuring = await dockerLines(["ps", "-a", "--filter", "label=com.amazon-insights.test-postgres=true", "--format", "{{.ID}}"]);
    const created = containersDuring.filter((id) => !containersBefore.has(id));
    assert.equal(created.length, 1);
    containerId = created[0]!;
    [volumeName] = await dockerLines(["inspect", "--format", "{{range .Mounts}}{{.Name}}{{end}}", containerId]);
    assert.match(volumeName, /^[a-f0-9]{64}$/);
  } finally {
    await postgres.close();
  }

  assert.deepEqual(await dockerLines(["ps", "-a", "--filter", `id=${containerId}`, "--format", "{{.ID}}"]), []);
  assert.deepEqual(await dockerLines(["volume", "ls", "--filter", `name=^${volumeName}$`, "--format", "{{.Name}}"]), []);
});
```

- [ ] **Step 6: Run focused and project verification**

Run: `npx tsx --conditions=react-server --test tests/agent/postgres-test-container-lifecycle.test.ts`

Expected: three tests PASS and no `agent_pg_test_*` container remains.

Run: `npm run build`

Expected: Vinext build completes successfully.

- [ ] **Step 7: Commit**

```powershell
git add tests/agent/helpers/postgres-test-container.ts tests/agent/postgres-test-container-lifecycle.test.ts
git commit -m "fix(test): remove PostgreSQL test containers and volumes"
```
