import { threadId, parentPort, workerData } from "node:worker_threads";

import type {
  ReserveModelBudgetInput,
  TransitionModelBudgetInput,
} from "../../../server/db/model-budget-repository";
import { openSqliteAgentRepository } from "../../../server/db/sqlite-repository";

type ModelBudgetWorkerData = {
  path: string;
  barrier: SharedArrayBuffer;
  barrierTimeoutMs: number;
  repositoryNow?: string;
} & (
  | { operation: "reserve"; input: ReserveModelBudgetInput }
  | { operation: "dispatch"; input: TransitionModelBudgetInput }
  | { operation: "release"; input: TransitionModelBudgetInput }
  | {
      operation: "reserve-dispatch";
      reserveInput: ReserveModelBudgetInput;
      dispatchInput: TransitionModelBudgetInput;
    }
);

const data = workerData as ModelBudgetWorkerData;
const barrier = new Int32Array(data.barrier);
const repository = openSqliteAgentRepository({
  path: data.path,
  busyTimeoutMs: 5_000,
  ...(data.repositoryNow === undefined
    ? {}
    : { nowProvider: () => new Date(data.repositoryNow!) }),
});

try {
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  if (
    !Number.isSafeInteger(data.barrierTimeoutMs) ||
    data.barrierTimeoutMs <= 0
  ) {
    throw new TypeError("Invalid model budget worker barrier timeout");
  }
  if (Atomics.wait(barrier, 1, 0, data.barrierTimeoutMs) === "timed-out") {
    const timeout = new Error("Model budget worker barrier timed out") as Error & {
      code: string;
    };
    timeout.name = "ModelBudgetWorkerBarrierTimeoutError";
    timeout.code = "MODEL_BUDGET_WORKER_BARRIER_TIMEOUT";
    throw timeout;
  }

  let value: unknown;
  switch (data.operation) {
    case "reserve":
      value = await repository.reserveModelBudget(data.input);
      break;
    case "dispatch":
      value = await repository.dispatchModelBudget(data.input);
      break;
    case "release":
      value = await repository.releaseModelBudget(data.input);
      break;
    case "reserve-dispatch": {
      const reserved = await repository.reserveModelBudget(data.reserveInput);
      const dispatched = await repository.dispatchModelBudget({
        ...data.dispatchInput,
        reservationId: reserved.reservation.id,
      });
      value = {
        reserved,
        dispatched,
        providerCalls: dispatched.transitioned ? 1 : 0,
      };
      break;
    }
  }
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
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(failure.scope === undefined ? {} : { scope: failure.scope }),
      ...(failure.metric === undefined ? {} : { metric: failure.metric }),
    },
  });
} finally {
  repository.close();
}
