import { claimAlexaPublicationWorker } from "../../scripts/lib/alexa-publication-state.mjs";

const [worktree, token] = process.argv.slice(2);
const claim = claimAlexaPublicationWorker(worktree, { token, pid: process.pid });
process.stdout.write(`${JSON.stringify(claim)}\n`);
setInterval(() => {}, 60_000);
