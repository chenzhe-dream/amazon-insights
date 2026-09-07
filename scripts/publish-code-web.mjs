import { loadLocalEnv } from "./lib/local-env.mjs";
import { prepareCodeWebPublication, submitCodeWebPublication, readCodeWebPublicationStatus } from "./lib/code-web-publication.mjs";

loadLocalEnv();
const [mode, artifactId, extra] = process.argv.slice(2);
try {
  if (extra || (mode === "prepare" && artifactId) || !["prepare", "submit", "status"].includes(mode)) throw new Error();
  const action = { prepare: prepareCodeWebPublication, submit: submitCodeWebPublication, status: readCodeWebPublicationStatus }[mode];
  const result = await action({ worktree: process.cwd(), env: process.env, artifactId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "failed") process.exitCode = 1;
} catch {
  process.stderr.write("Code Web publication failed; verify source, target, current and publication state.\n");
  process.exitCode = 1;
}
