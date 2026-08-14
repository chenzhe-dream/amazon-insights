import { threadId, parentPort, workerData } from "node:worker_threads";

import type {
  ReserveModelBudgetInput,
  TransitionModelBudgetInput,
} from "../../../server/db/model-budget-repository";
import { openSqliteAgentRepository } from "../../../server/db/sqlite-repository";

type ModelBudgetWorkerData = {
  path: string;
  barrier: SharedArrayBuffer;
} & (
  | { operation: "reserve"; input: ReserveModelBudgetInput }
  | { operation: "dispatch"; input: TransitionModelBudgetInput }
);

const data = workerData as ModelBudgetWorkerData;
const barrier = new Int32Array(data.barrier);
const repository = openSqliteAgentRepository({
  path: data.path,
  busyTimeoutMs: 5_000,
});

try {
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  Atomics.wait(barrier, 1, 0);

  const value =
    data.operation === "reserve"
      ? await repository.reserveModelBudget(data.input)
      : await repository.dispatchModelBudget(data.input);
  parentPort?.postMessage({ ok: true, threadId, value });
} catch (error) {
  const failure = error as Error & {
    code?: string;
    scope?: string;
    metric?: string;
  };
  parentPort?.postMessage({
    ok: false,
    threadId,
    error: {
      name: failure.name,
      code: failure.code,
      scope: failure.scope,
      metric: failure.metric,
    },
  });
} finally {
  repository.close();
}
