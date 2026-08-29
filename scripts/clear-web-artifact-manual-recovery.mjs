import { resolveFormalWorktreeRoot } from "./lib/formal-worktree-root.mjs";
import { clearWebArtifactManualRecoverySync } from "./lib/web-artifact-store.mjs";

if (process.argv.slice(2).join(" ") !== "--confirm-quiescent") {
  throw new Error("Usage: node scripts/clear-web-artifact-manual-recovery.mjs --confirm-quiescent");
}
const worktree = resolveFormalWorktreeRoot();
console.log(clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true })
  ? "Web artifact manual-recovery fence cleared"
  : "No Web artifact manual-recovery fence found");
