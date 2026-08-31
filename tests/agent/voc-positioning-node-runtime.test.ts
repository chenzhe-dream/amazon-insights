import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("ordinary Node imports and executes VOC positioning without React conditions", () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const executed = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-name-pattern=full scooter facts execute",
      "tests/agent/voc-positioning-execution-service.test.ts",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
    },
  );

  assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /full scooter facts execute/);
  assert.match(executed.stdout, /pass 1/);
});

test("ordinary Node imports the production VOC composition root", () => {
  const executed = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      "const runtime = await import('./server/runtime/voc-positioning-runtime.ts'); const service = await import('./server/agent-service.ts'); if (typeof runtime.createVocPositioningRuntime !== 'function' || typeof service.createAgentService !== 'function') process.exit(2);",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`);
});

test("public Manual VOC modules remain marked server-only wrappers", () => {
  const wrappers = [
    [
      "server/data/manual-alexa-voc-projection-store.ts",
      "./manual-alexa-voc-projection-store.node.js",
    ],
    [
      "server/services/manual-alexa-voc-publication-service.ts",
      "./manual-alexa-voc-publication-service.node.js",
    ],
    [
      "server/services/manual-alexa-voc-retention-service.ts",
      "./manual-alexa-voc-retention-service.node.js",
    ],
  ] as const;

  for (const [path, implementation] of wrappers) {
    const source = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
    assert.equal(
      source,
      `import "server-only";\nexport * from "${implementation}";\n`,
      path,
    );
  }
});

test("production agent service imports Manual VOC Node implementations", () => {
  const source = readFileSync("server/agent-service.ts", "utf8");
  for (const implementation of [
    "./data/manual-alexa-voc-projection-store.node.js",
    "./services/manual-alexa-voc-publication-service.node.js",
    "./services/manual-alexa-voc-retention-service.node.js",
  ]) {
    assert.match(source, new RegExp(`from [\"']${implementation}[\"']`));
  }
  assert.doesNotMatch(
    source,
    /from ["']\.\/(?:data|services)\/manual-alexa-voc-(?:projection-store|publication-service|retention-service)["']/,
  );
});
