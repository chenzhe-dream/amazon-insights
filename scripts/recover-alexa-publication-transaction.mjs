import path from "node:path";

import { recoverAlexaPublicationTransactionSync } from "./lib/alexa-publication-state.mjs";
import { resolveFormalWorktreeRoot } from "./lib/formal-worktree-root.mjs";

const decision = process.argv.includes("--commit")
  ? "commit"
  : process.argv.includes("--rollback")
    ? "rollback"
    : null;
if (!decision || (process.argv.includes("--commit") && process.argv.includes("--rollback"))) {
  throw new Error("Usage: node scripts/recover-alexa-publication-transaction.mjs --commit|--rollback");
}
const worktree = resolveFormalWorktreeRoot({
  env: process.env,
  cwd: path.resolve("."),
});
const recovered = recoverAlexaPublicationTransactionSync(worktree, { decision });
console.log(recovered ? `Alexa publication transaction ${decision} completed` : "No Alexa publication transaction found");
