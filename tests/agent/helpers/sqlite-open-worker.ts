import { parentPort, workerData } from "node:worker_threads";

import { openSqliteAgentRepository } from "../../../server/db/sqlite-repository";

const data = workerData as {
  path: string;
  barrier: SharedArrayBuffer;
};
const barrier = new Int32Array(data.barrier);

Atomics.add(barrier, 0, 1);
Atomics.notify(barrier, 0);
Atomics.wait(barrier, 1, 0);

const repository = openSqliteAgentRepository({
  path: data.path,
  busyTimeoutMs: 5_000,
});

try {
  parentPort?.postMessage({
    diagnostics: repository.getConnectionDiagnostics(),
    migrations: repository.listAppliedMigrations(),
  });
} finally {
  repository.close();
}
