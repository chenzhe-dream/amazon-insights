import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import assert from "node:assert/strict";

import type {
  AdminUserPresenceHeartbeatInput,
  AdminUserPresenceHeartbeatResult,
} from "../../server/db/admin-user-presence-repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { registerAdminUserPresenceRepositoryContract } from "./helpers/admin-user-presence-repository-contract";

registerAdminUserPresenceRepositoryContract("SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "admin-presence-sqlite-"));
  const path = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const workers = new Set<Worker>();
  return {
    repository,
    async inspectLastSeenAt(sessionId: string) {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        const row = database
          .prepare("SELECT last_seen_at FROM sessions WHERE id = ?")
          .get(sessionId) as { last_seen_at: string | null } | undefined;
        return row?.last_seen_at ?? null;
      } finally {
        database.close();
      }
    },
    async beginRevocationTransition(input: AdminUserPresenceHeartbeatInput) {
      const heartbeatWorker = startRaceWorker(workers, {
        mode: "heartbeat",
        path,
        input,
      });
      await waitForWorkerMessage(heartbeatWorker, "ready");
      const revokeWorker = startRaceWorker(workers, {
        mode: "revoke",
        path,
        sessionId: input.sessionId,
        revokedAt: "2026-08-31T11:59:59.000Z",
      });
      await waitForWorkerMessage(revokeWorker, "held");

      const started = waitForWorkerMessage(heartbeatWorker, "starting");
      const result = waitForWorkerMessage(heartbeatWorker, "result");
      let heartbeatStarted = false;
      let transitionFinished = false;
      return {
        async startHeartbeat() {
          if (!heartbeatStarted) {
            heartbeatStarted = true;
            heartbeatWorker.postMessage({ type: "start" });
          }
          const message = await result;
          return message.result as AdminUserPresenceHeartbeatResult;
        },
        async waitUntilHeartbeatBlocked() {
          await started;
          const state = await Promise.race([
            result.then(() => "settled" as const),
            delay(100).then(() => "blocked" as const),
          ]);
          assert.equal(state, "blocked", "SQLite heartbeat must wait for revocation commit");
        },
        async commit() {
          if (transitionFinished) return;
          transitionFinished = true;
          const finished = waitForWorkerMessage(revokeWorker, "finished");
          revokeWorker.postMessage({ type: "commit" });
          await finished;
        },
        async close() {
          if (!transitionFinished) {
            transitionFinished = true;
            const finished = waitForWorkerMessage(revokeWorker, "finished");
            revokeWorker.postMessage({ type: "rollback" });
            await finished.catch(() => undefined);
          }
          await Promise.allSettled([
            heartbeatWorker.terminate(),
            revokeWorker.terminate(),
          ]);
          workers.delete(heartbeatWorker);
          workers.delete(revokeWorker);
        },
      };
    },
    async close() {
      await Promise.allSettled([...workers].map((worker) => worker.terminate()));
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
});

function startRaceWorker(
  workers: Set<Worker>,
  workerData: Record<string, unknown>,
): Worker {
  const worker = new Worker(
    new URL("./helpers/sqlite-admin-user-presence-race-worker.ts", import.meta.url),
    {
      workerData,
      execArgv: ["--import", "tsx", "--conditions=react-server"],
    },
  );
  workers.add(worker);
  worker.once("exit", () => workers.delete(worker));
  return worker;
}

function waitForWorkerMessage(
  worker: Worker,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object" || message === null ||
        !("type" in message) || message.type !== type
      ) return;
      cleanup();
      resolve(message as Record<string, unknown>);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Presence race worker exited before ${type}: ${code}`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
