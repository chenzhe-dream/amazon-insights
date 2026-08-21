import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

import { createAgentService } from "../../server/agent-service";
import { buildAgentApp } from "../../server/app";
import type { RuntimeAgentRepository } from "../../server/db/repository";
import type { registerLocalVocRoute } from "../../server/routes/local-voc";
import type { createProductDefinitionRuntime } from "../../server/runtime/product-definition-runtime";
import type { createTrafficAnalysisRuntime } from "../../server/runtime/traffic-analysis-runtime";
import type { VocPositioningRuntimeOptions } from "../../server/runtime/voc-positioning-runtime";
import type { SifTrafficSnapshotTask } from "../../server/services/sif-traffic-snapshot-task";

type AcceptsRuntimeRepository<Repository> =
  RuntimeAgentRepository extends Repository ? true : false;
type Assert<T extends true> = T;

type BuildAgentAppRepository = NonNullable<
  NonNullable<Parameters<typeof buildAgentApp>[0]>["repository"]
>;
type CreateAgentServiceRepository = NonNullable<
  NonNullable<Parameters<typeof createAgentService>[0]>["repository"]
>;
type LocalVocRepository = NonNullable<
  Parameters<typeof registerLocalVocRoute>[1]
>;
type TrafficRuntimeRepository = Parameters<
  typeof createTrafficAnalysisRuntime
>[0]["repository"];
type ProductRuntimeRepository = Parameters<
  typeof createProductDefinitionRuntime
>[0]["repository"];
type SifSnapshotRepository = ConstructorParameters<
  typeof SifTrafficSnapshotTask
>[0]["repository"];

const consumerRepositoryContracts: readonly [
  Assert<AcceptsRuntimeRepository<BuildAgentAppRepository>>,
  Assert<AcceptsRuntimeRepository<CreateAgentServiceRepository>>,
  Assert<AcceptsRuntimeRepository<VocPositioningRuntimeOptions["repository"]>>,
  Assert<AcceptsRuntimeRepository<TrafficRuntimeRepository>>,
  Assert<AcceptsRuntimeRepository<ProductRuntimeRepository>>,
  Assert<AcceptsRuntimeRepository<LocalVocRepository>>,
  Assert<AcceptsRuntimeRepository<SifSnapshotRepository>>,
] = [true, true, true, true, true, true, true];

function createRuntimeRepositoryStub(): RuntimeAgentRepository {
  return new Proxy(Object.create(null) as RuntimeAgentRepository, {
    get(_target, property) {
      if (property === "then") return undefined;
      return async () => {
        throw new Error(`Unexpected repository call: ${String(property)}`);
      };
    },
  });
}

const env = {
  AGENT_SERVICE_PROXY_TOKEN: "runtime-repository-contract-token",
  AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
  AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
};

const contractFiles = new Set([
  "tests/agent/runtime-repository-contract.test.ts",
  "server/db/repository.ts",
  "server/app.ts",
  "server/agent-service.ts",
  "server/runtime/voc-positioning-runtime.ts",
  "server/runtime/traffic-analysis-runtime.ts",
  "server/runtime/product-definition-runtime.ts",
  "server/routes/local-voc.ts",
  "server/services/sif-traffic-snapshot-task.ts",
].map((path) => path.toLowerCase()));

test("runtime repository consumer contracts compile without concrete storage", () => {
  const testFile = fileURLToPath(import.meta.url);
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists);
  assert.ok(configPath, "tsconfig.json must be discoverable");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    projectRoot,
    { noEmit: true, incremental: false },
    configPath,
  );
  const program = ts.createProgram([testFile], parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => {
      if (!diagnostic.file) return false;
      const relative = diagnostic.file.fileName
        .slice(projectRoot.length)
        .replaceAll("\\", "/")
        .replace(/^\//, "")
        .toLowerCase();
      return contractFiles.has(relative);
    })
    .map((diagnostic) => ts.formatDiagnostic(diagnostic, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => projectRoot,
      getNewLine: () => "\n",
    }));

  assert.deepEqual(diagnostics, []);
});

test("a non-SQLite runtime repository stub composes at the service boundary", async () => {
  assert.deepEqual(consumerRepositoryContracts, [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
  const repository = createRuntimeRepositoryStub();

  const app = buildAgentApp({ env, repository });
  await app.close();

  const service = await createAgentService({ env, repository });
  await service.stop();
});
