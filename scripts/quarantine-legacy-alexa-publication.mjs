import { resolveFormalWorktreeRoot } from "./lib/formal-worktree-root.mjs";
import { quarantineLegacyAlexaPublicationLockSync } from "./lib/alexa-publication-state.mjs";

if (process.argv.slice(2).join(" ") !== "--confirm-quiescent") {
  throw new Error("Usage: node scripts/quarantine-legacy-alexa-publication.mjs --confirm-quiescent");
}

const worktree = resolveFormalWorktreeRoot();
const quarantined = quarantineLegacyAlexaPublicationLockSync(worktree, { confirmQuiescent: true });
console.log(quarantined ? "旧版 Alexa 发布锁已隔离" : "未发现旧版 Alexa 发布锁");
