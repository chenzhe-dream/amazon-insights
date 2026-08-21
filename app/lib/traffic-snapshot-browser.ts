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
  runId: string | null;
  marketplace: string;
  asins: readonly string[];
  request(path: string): Promise<TrafficSnapshotResponse>;
  onState?(state: TrafficSnapshotClientState): void;
}) {
  let state: TrafficSnapshotClientState = { kind: "pending" };
  const update = (next: TrafficSnapshotClientState) => {
    state = next;
    input.onState?.(state);
  };
  return Object.freeze({
    current: () => state,
    async refresh() {
      if (!input.runId) return state;
      const response = await input.request(`/v1/runs/${encodeURIComponent(input.runId)}/traffic-snapshot`);
      if (response.status === 404) {
        update({ kind: "legacy", label: "legacy" });
        return state;
      }
      if (!response.ok) return state;
      const parsed = TrafficSnapshotReadResponseSchema.safeParse(await response.json());
      if (
        !parsed.success ||
        parsed.data.marketplace !== input.marketplace ||
        !sameAsinScope(parsed.data.asins, input.asins)
      ) return state;
      update({ kind: "dynamic", snapshot: parsed.data });
      return state;
    },
  });
}
