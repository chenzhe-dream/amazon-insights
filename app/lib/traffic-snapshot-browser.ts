import {
  TrafficSnapshotReadResponseSchema,
  type TrafficSnapshotReadResponse,
} from "../../shared/agent-contracts";

export type TrafficSnapshotClientState =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "legacy"; label: "legacy" }>
  | Readonly<{ kind: "dynamic"; snapshot: TrafficSnapshotReadResponse }>;

type TrafficSnapshotResponse = Readonly<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

function sameAsinScope(left: readonly string[], right: readonly string[]) {
  return [...left].sort().join(",") === [...right].sort().join(",");
}

export function createTrafficSnapshotOwner(input: {
  sessionIdentity: string;
  organizationId: string;
  logoutPending: boolean;
  runId: string | null;
  marketplace: string;
  asins: readonly string[];
  request(path: string): Promise<TrafficSnapshotResponse>;
  onState?(state: TrafficSnapshotClientState): void;
}) {
  let binding = input;
  let state: TrafficSnapshotClientState = { kind: "pending" };
  const update = (next: TrafficSnapshotClientState) => {
    state = next;
    input.onState?.(state);
  };
  return Object.freeze({
    current: () => state,
    rebind(next: Pick<typeof input, "sessionIdentity" | "organizationId" | "logoutPending" | "runId" | "marketplace" | "asins">) {
      binding = { ...binding, ...next };
      update({ kind: "pending" });
      return state;
    },
    async refresh() {
      const requestedBinding = binding;
      if (requestedBinding.logoutPending || !requestedBinding.runId) return state;
      const response = await requestedBinding.request(`/v1/runs/${encodeURIComponent(requestedBinding.runId)}/traffic-snapshot`);
      if (binding !== requestedBinding) return state;
      if (response.status === 404) {
        update({ kind: "legacy", label: "legacy" });
        return state;
      }
      if (!response.ok) {
        update({ kind: "pending" });
        return state;
      }
      const parsed = TrafficSnapshotReadResponseSchema.safeParse(await response.json());
      if (binding !== requestedBinding) return state;
      if (
        !parsed.success ||
        parsed.data.marketplace !== requestedBinding.marketplace ||
        !sameAsinScope(parsed.data.asins, requestedBinding.asins)
      ) {
        update({ kind: "pending" });
        return state;
      }
      update({ kind: "dynamic", snapshot: parsed.data });
      return state;
    },
  });
}
