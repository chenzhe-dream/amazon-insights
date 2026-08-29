import { resolveFormalWorktreeRoot } from "./lib/formal-worktree-root.mjs";
import { clearWebArtifactManualRecoverySync } from "./lib/web-artifact-store.mjs";

const flags = new Set(process.argv.slice(2));
if (!flags.has("--confirm-quiescent") || [...flags].some((flag) => !new Set([
  "--confirm-quiescent", "--confirm-global-quiescent", "--quarantine-token-lock-owners",
]).has(flag))) throw new Error(
  "Usage: node scripts/clear-web-artifact-manual-recovery.mjs --confirm-quiescent [--confirm-global-quiescent --quarantine-token-lock-owners]",
);
if (flags.has("--quarantine-token-lock-owners") && !flags.has("--confirm-global-quiescent")) {
  throw new Error("Token-lock quarantine requires --confirm-global-quiescent");
}
const worktree = resolveFormalWorktreeRoot();
console.log(clearWebArtifactManualRecoverySync({
  worktree,
  confirmQuiescent: true,
  confirmGlobalQuiescent: flags.has("--confirm-global-quiescent"),
  quarantineTokenLockOwners: flags.has("--quarantine-token-lock-owners"),
})
  ? "Web artifact manual-recovery fence cleared"
  : "No Web artifact manual-recovery fence found");
