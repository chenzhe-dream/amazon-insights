import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { resolveRuntimeRoots } from "./runtime-roots.mjs";

/** Keep mutable sync caches out of a formal code worktree. The committed module is only a seed. */
export function generatedAppDataPath(codeRoot, fileName, env = process.env) {
  if (!/^[a-z0-9-]+\.ts$/.test(fileName)) throw new TypeError("Invalid generated data file name");
  const root = path.resolve(codeRoot);
  const source = path.join(root, "app", fileName);
  const formal = Boolean(env.AGENT_FORMAL_WORKTREE_ROOT);
  const nonUs = Boolean(env.AGENT_SYNC_MARKETPLACE && env.AGENT_SYNC_MARKETPLACE !== "US");
  if (!formal && !nonUs) return source;
  if (formal && path.resolve(env.AGENT_FORMAL_WORKTREE_ROOT) !== root) {
    throw new Error("Formal generated data root does not match code root");
  }
  const { dataRoot } = resolveRuntimeRoots({ codeRoot: root, formal, env });
  // The legacy shared cache is US-only. Non-US jobs must never seed from it.
  // Hash the full owner identity so different organizations/projects cannot mix.
  if (nonUs) {
    const scope = [env.AGENT_EXECUTION_ORGANIZATION_ID, env.AGENT_SYNC_PROJECT_ID, env.AGENT_SYNC_MARKETPLACE];
    if (scope.some(value => !value)) throw new Error("Non-US generated data requires an exact project scope");
    const owner = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
    const target = path.join(dataRoot, "generated-project-data", owner, fileName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fileName === "competitor-data.ts" && !fs.existsSync(target)) {
      try { fs.writeFileSync(target, "export const refreshedCatalog = [];\n", { flag: "wx" }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
    }
    return target;
  }
  const target = path.join(dataRoot, "generated-app-data", fileName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target) && fs.existsSync(source)) {
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return target;
}
