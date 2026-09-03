import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveRuntimeRoots } from "../../scripts/lib/runtime-roots.mjs";

const codeRoot = path.resolve("C:/workspace/product-insights");
const sharedRoot = path.resolve("C:/runtime/product-insights");
const dataRoot = path.join(sharedRoot, "data");
const runtimeRoot = path.join(sharedRoot, "runtime");
const commit = "a".repeat(40);

test("formal roots come only from explicit absolute shared paths", () => {
  assert.throws(
    () => resolveRuntimeRoots({ codeRoot, formal: true, env: {}, commit }),
    /AGENT_DATA_ROOT/,
  );
  assert.throws(
    () => resolveRuntimeRoots({
      codeRoot,
      formal: true,
      env: { AGENT_DATA_ROOT: "relative-data", AGENT_RUNTIME_ROOT: runtimeRoot },
      commit,
    }),
    /AGENT_DATA_ROOT.*absolute/,
  );
  assert.throws(
    () => resolveRuntimeRoots({
      codeRoot,
      formal: true,
      env: {
        AGENT_DATA_ROOT: path.join(codeRoot, "data"),
        AGENT_RUNTIME_ROOT: runtimeRoot,
      },
      commit,
    }),
    /AGENT_DATA_ROOT.*codeRoot/,
  );

  assert.deepEqual(
    resolveRuntimeRoots({
      codeRoot,
      formal: true,
      env: { AGENT_DATA_ROOT: dataRoot, AGENT_RUNTIME_ROOT: runtimeRoot },
      commit,
    }),
    { codeRoot, dataRoot, runtimeRoot, commit, mode: "formal" },
  );
});

test("development uses explicit roots when supplied and otherwise stays worktree-local", () => {
  assert.deepEqual(resolveRuntimeRoots({ codeRoot, formal: false, env: {}, commit }), {
    codeRoot,
    dataRoot: path.join(codeRoot, "data"),
    runtimeRoot: path.join(codeRoot, ".runtime"),
    commit,
    mode: "development",
  });

  assert.deepEqual(resolveRuntimeRoots({
    codeRoot,
    formal: false,
    env: { AGENT_DATA_ROOT: dataRoot, AGENT_RUNTIME_ROOT: runtimeRoot },
    commit,
  }), {
    codeRoot,
    dataRoot,
    runtimeRoot,
    commit,
    mode: "development",
  });
});
