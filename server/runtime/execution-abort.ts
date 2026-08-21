export type TrustedExecutionAbortKind =
  | "run-cancelled"
  | "worker-stopping"
  | "lease-lost";

export interface TrustedExecutionAbortReason {
  readonly kind: TrustedExecutionAbortKind;
}

const trustedReasons = new WeakSet<object>();

export function createTrustedExecutionAbortReason(
  kind: TrustedExecutionAbortKind,
): TrustedExecutionAbortReason {
  const reason = Object.freeze({ kind });
  trustedReasons.add(reason);
  return reason;
}

export function trustedExecutionAbortKind(
  signal: AbortSignal | undefined,
): TrustedExecutionAbortKind | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason;
  if (
    reason === null ||
    (typeof reason !== "object" && typeof reason !== "function") ||
    !trustedReasons.has(reason)
  ) {
    return null;
  }
  const kind = (reason as { kind?: unknown }).kind;
  return kind === "run-cancelled" ||
    kind === "worker-stopping" ||
    kind === "lease-lost"
    ? kind
    : null;
}
