import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import type { AdminUserPresenceHeartbeatInput } from "../../../server/db/admin-user-presence-repository";
import { openSqliteAgentRepository } from "../../../server/db/sqlite-repository";

type WorkerInput =
  | Readonly<{
      mode: "heartbeat";
      path: string;
      input: AdminUserPresenceHeartbeatInput;
    }>
  | Readonly<{
      mode: "revoke";
      path: string;
      sessionId: string;
      revokedAt: string;
    }>;

const data = workerData as WorkerInput;
const port = parentPort;

if (!port) throw new Error("Presence race worker requires a parent port");

if (data.mode === "heartbeat") {
  const repository = openSqliteAgentRepository({
    path: data.path,
    busyTimeoutMs: 5_000,
  });
  port.postMessage({ type: "ready" });
  port.once("message", async (message: unknown) => {
    try {
      if (!isMessage(message, "start")) {
        throw new Error("Presence heartbeat worker received an invalid command");
      }
      port.postMessage({ type: "starting" });
      const result = await repository.adminUserPresence.recordHeartbeat(data.input);
      port.postMessage({ type: "result", result });
    } finally {
      repository.close();
    }
  });
} else {
  const database = new DatabaseSync(data.path);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("BEGIN IMMEDIATE");
  database.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE id = ?",
  ).run(data.revokedAt, data.sessionId);
  port.postMessage({ type: "held" });
  port.once("message", (message: unknown) => {
    try {
      if (isMessage(message, "commit")) {
        database.exec("COMMIT");
      } else if (isMessage(message, "rollback")) {
        database.exec("ROLLBACK");
      } else {
        throw new Error("Presence revocation worker received an invalid command");
      }
      port.postMessage({ type: "finished" });
    } finally {
      database.close();
    }
  });
}

function isMessage(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === type;
}
