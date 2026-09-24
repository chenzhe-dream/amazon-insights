import fs from "node:fs";
import path from "node:path";

import { resolveRuntimeRoots } from "./runtime-roots.mjs";

/** Keep mutable sync caches out of a formal code worktree. The committed module is only a seed. */
export function generatedAppDataPath(codeRoot, fileName, env = process.env) {
  if (!/^[a-z0-9-]+\.ts$/.test(fileName)) throw new TypeError("Invalid generated data file name");
  const root = path.resolve(codeRoot);
  const source = path.join(root, "app", fileName);
  if (!env.AGENT_FORMAL_WORKTREE_ROOT) return source;
  if (path.resolve(env.AGENT_FORMAL_WORKTREE_ROOT) !== root) {
    throw new Error("Formal generated data root does not match code root");
  }
  const { dataRoot } = resolveRuntimeRoots({ codeRoot: root, formal: true, env });
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
