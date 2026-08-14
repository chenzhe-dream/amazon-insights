import { threadId, parentPort, workerData } from "node:worker_threads";

import type { FinalizeAgentRunInput } from "../../../server/db/agent-run-repository";
import { openSqliteAgentRepository } from "../../../server/db/sqlite-repository";

interface AgentRunWorkerData {
  path: string;
  input: FinalizeAgentRunInput;
  barrier: SharedArrayBuffer;
  barrierTimeoutMs: number;
}

const data = workerData as AgentRunWorkerData;
const barrier = new Int32Array(data.barrier);
const repository = openSqliteAgentRepository({
  path: data.path,
  busyTimeoutMs: 5_000,
});

try {
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  if (
    !Number.isSafeInteger(data.barrierTimeoutMs) ||
    data.barrierTimeoutMs <= 0
  ) {
    throw new TypeError("Invalid AgentRun worker barrier timeout");
  }
  if (Atomics.wait(barrier, 1, 0, data.barrierTimeoutMs) === "timed-out") {
    const timeout = new Error("AgentRun worker barrier timed out") as Error & {
      code: string;
    };
    timeout.name = "AgentRunWorkerBarrierTimeoutError";
    timeout.code = "AGENT_RUN_WORKER_BARRIER_TIMEOUT";
    throw timeout;
  }

  const value = await repository.finalizeAgentRun(data.input);
  parentPort?.postMessage({ ok: true, threadId, value });
} catch (error) {
  const failure = error as Error & { code?: string };
  parentPort?.postMessage({
    ok: false,
    threadId,
    error: {
      name: failure.name,
      ...(failure.code === undefined ? {} : { code: failure.code }),
    },
  });
} finally {
  repository.close();
}
