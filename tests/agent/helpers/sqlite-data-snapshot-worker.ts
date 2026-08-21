import { parentPort, workerData } from "node:worker_threads";

import type { CreateDataSnapshotForRunInput } from "../../../server/db/data-snapshot-repository";
import { DataSnapshotConflictError } from "../../../server/db/data-snapshot-repository";
import { openSqliteAgentRepository } from "../../../server/db/sqlite-repository";

const data = workerData as Readonly<{
  path: string;
  input: CreateDataSnapshotForRunInput;
  barrier: SharedArrayBuffer;
}>;
const barrier = new Int32Array(data.barrier);
const repository = openSqliteAgentRepository({
  path: data.path,
  busyTimeoutMs: 5_000,
});

try {
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  const barrierResult = Atomics.wait(barrier, 1, 0, 5_000);
  if (barrierResult === "timed-out") {
    throw new Error("snapshot worker barrier timed out");
  }

  try {
    const result = await repository.createDataSnapshotForRun(data.input);
    parentPort?.postMessage({
      kind: "success",
      created: result.created,
      id: result.snapshot.id,
      contentHash: result.snapshot.contentHash,
    });
  } catch (error) {
    if (error instanceof DataSnapshotConflictError) {
      parentPort?.postMessage({ kind: "conflict" });
    } else {
      throw error;
    }
  }
} finally {
  repository.close();
}
