import { parentPort, workerData } from "node:worker_threads";

import { openSqliteAgentRepository } from "../../../server/db/sqlite-repository";

const data = workerData as {
  path: string;
  ownerId: string;
  barrier: SharedArrayBuffer;
};
const barrier = new Int32Array(data.barrier);
const repository = openSqliteAgentRepository({
  path: data.path,
  busyTimeoutMs: 5_000,
});

try {
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  Atomics.wait(barrier, 1, 0);

  const claim = await repository.claimNextJob({
    ownerId: data.ownerId,
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 30_000,
  });
  parentPort?.postMessage(claim);
} finally {
  repository.close();
}
