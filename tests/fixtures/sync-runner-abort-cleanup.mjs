import { writeFileSync } from "node:fs";

const startMarker = process.env.SYNC_RUNNER_START_MARKER;
if (!startMarker) throw new Error("sync runner start marker path is required");

writeFileSync(startMarker, "started", "utf8");
setInterval(() => undefined, 1_000);
