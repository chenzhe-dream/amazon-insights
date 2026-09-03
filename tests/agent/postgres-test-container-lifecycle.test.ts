import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import {
  postgresTestContainerRemoveArgs,
  postgresTestContainerRunArgs,
  startPostgresTestContainer,
} from "./helpers/postgres-test-container";

const execFileAsync = promisify(execFile);

async function dockerLines(args: string[]): Promise<string[]> {
  const result = await execFileAsync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

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

test("closing a PostgreSQL test container leaves no container or anonymous volume", async () => {
  const containersBefore = new Set(
    await dockerLines([
      "ps",
      "-a",
      "--filter",
      "label=com.amazon-insights.test-postgres=true",
      "--format",
      "{{.ID}}",
    ]),
  );
  const postgres = await startPostgresTestContainer();
  let containerId = "";
  let volumeName = "";
  try {
    const containersDuring = await dockerLines([
      "ps",
      "-a",
      "--filter",
      "label=com.amazon-insights.test-postgres=true",
      "--format",
      "{{.ID}}",
    ]);
    const created = containersDuring.filter((id) => !containersBefore.has(id));
    assert.equal(created.length, 1);
    containerId = created[0]!;
    [volumeName] = await dockerLines([
      "inspect",
      "--format",
      "{{range .Mounts}}{{.Name}}{{end}}",
      containerId,
    ]);
    assert.match(volumeName, /^[a-f0-9]{64}$/);
  } finally {
    await postgres.close();
  }

  assert.deepEqual(
    await dockerLines(["ps", "-a", "--filter", `id=${containerId}`, "--format", "{{.ID}}"]),
    [],
  );
  const volumesAfter = await dockerLines(["volume", "ls", "--format", "{{.Name}}"]).then(
    (names) => new Set(names),
  );
  assert.equal(volumesAfter.has(volumeName), false);
});
