import type { ManualAlexaVocRecord } from "../shared/agent-contracts";

export type ManualVocMarketplace = "US";
export type ManualVocStatus = "loading" | "ready" | "missing" | "source-error" | "protocol-conflict";
export type OverlayRecord = ManualAlexaVocRecord & Readonly<{ sessionOrgEpoch: number }>;
export type ManualVocOverlayState = Readonly<{
  identity: string;
  organizationId: string;
  sessionOrgEpoch: number;
  requestGeneration: number;
  overlay: ReadonlyMap<string, OverlayRecord>;
  statusByKey: ReadonlyMap<string, ManualVocStatus>;
}>;

type ManualVocScope = Readonly<{
  organizationId: string;
  marketplace: ManualVocMarketplace;
}>;

type RequestContext = Readonly<{
  sessionOrgEpoch: number;
  requestGeneration: number;
  scope: ManualVocScope;
}>;

type ManualVocAction =
  | Readonly<{ type: "identity-changed"; identity: string; organizationId: string }>
  | (RequestContext & Readonly<{ type: "hydration-started"; asins: readonly string[] }>)
  | (RequestContext & Readonly<{ type: "hydration-succeeded"; requestedAsins: readonly string[]; records: readonly ManualAlexaVocRecord[] }>)
  | (RequestContext & Readonly<{ type: "hydration-failed"; asins: readonly string[] }>)
  | (RequestContext & Readonly<{ type: "import-succeeded"; record: ManualAlexaVocRecord }>);

export const manualVocOverlayKey = (
  organizationId: string,
  marketplace: ManualVocMarketplace,
  asin: string,
) => `${organizationId}:${marketplace}:${asin.trim().toUpperCase()}`;

export function abortManualVocRequests(requests: Map<number, AbortController>) {
  for (const controller of requests.values()) controller.abort();
  requests.clear();
}

export function createManualVocOverlayState(
  identity: string,
  organizationId: string,
  sessionOrgEpoch = 1,
): ManualVocOverlayState {
  return {
    identity,
    organizationId,
    sessionOrgEpoch,
    requestGeneration: 0,
    overlay: new Map(),
    statusByKey: new Map(),
  };
}

export const identityChanged = (identity: string, organizationId: string): ManualVocAction => ({
  type: "identity-changed",
  identity,
  organizationId,
});

export const hydrationStarted = (input: RequestContext & Readonly<{ asins: readonly string[] }>): ManualVocAction => ({
  type: "hydration-started",
  ...input,
});

export const hydrationSucceeded = (input: RequestContext & Readonly<{
  requestedAsins: readonly string[];
  records: readonly ManualAlexaVocRecord[];
}>): ManualVocAction => ({ type: "hydration-succeeded", ...input });

export const hydrationFailed = (input: RequestContext & Readonly<{ asins: readonly string[] }>): ManualVocAction => ({
  type: "hydration-failed",
  ...input,
});

export const importSucceeded = (input: RequestContext & Readonly<{ record: ManualAlexaVocRecord }>): ManualVocAction => ({
  type: "import-succeeded",
  ...input,
});

function validScope(state: ManualVocOverlayState, action: RequestContext) {
  return action.sessionOrgEpoch === state.sessionOrgEpoch
    && action.scope.organizationId === state.organizationId
    && action.scope.marketplace === "US";
}

function sameExposedRevisionContent(left: ManualAlexaVocRecord, right: ManualAlexaVocRecord) {
  return left.asin === right.asin
    && left.marketplace === right.marketplace
    && left.capturedAt === right.capturedAt
    && JSON.stringify(left.normalizedRecord) === JSON.stringify(right.normalizedRecord);
}

function mergeRecord(
  state: ManualVocOverlayState,
  overlay: Map<string, OverlayRecord>,
  statuses: Map<string, ManualVocStatus>,
  scope: ManualVocScope,
  incoming: ManualAlexaVocRecord,
) {
  if (incoming.marketplace !== scope.marketplace) return;
  const key = manualVocOverlayKey(scope.organizationId, scope.marketplace, incoming.asin);
  const current = overlay.get(key);
  const next: OverlayRecord = { ...incoming, sessionOrgEpoch: state.sessionOrgEpoch };
  if (!current) {
    overlay.set(key, next);
    statuses.set(key, "ready");
    return;
  }
  const order = BigInt(incoming.revision) - BigInt(current.revision);
  if (order < BigInt(0)) {
    statuses.set(key, "ready");
    return;
  }
  if (order === BigInt(0) && !sameExposedRevisionContent(current, incoming)) {
    statuses.set(key, "protocol-conflict");
    return;
  }
  if (order === BigInt(0) && current.source === "postgres" && incoming.source !== "postgres") {
    statuses.set(key, "ready");
    return;
  }
  overlay.set(key, next);
  statuses.set(key, "ready");
}

export function reduceManualVoc(
  state: ManualVocOverlayState,
  action: ManualVocAction,
): ManualVocOverlayState {
  if (action.type === "identity-changed") {
    if (action.identity === state.identity && action.organizationId === state.organizationId) return state;
    return createManualVocOverlayState(action.identity, action.organizationId, state.sessionOrgEpoch + 1);
  }
  if (!validScope(state, action)) return state;

  if (action.type === "hydration-started") {
    if (action.requestGeneration <= state.requestGeneration) return state;
    const statuses = new Map(state.statusByKey);
    for (const asin of action.asins) {
      statuses.set(manualVocOverlayKey(action.scope.organizationId, action.scope.marketplace, asin), "loading");
    }
    return { ...state, requestGeneration: action.requestGeneration, statusByKey: statuses };
  }

  if (action.type === "import-succeeded") {
    if (action.requestGeneration < state.requestGeneration || action.record.marketplace !== action.scope.marketplace) return state;
    const overlay = new Map(state.overlay);
    const statuses = new Map(state.statusByKey);
    mergeRecord(state, overlay, statuses, action.scope, action.record);
    return { ...state, requestGeneration: action.requestGeneration, overlay, statusByKey: statuses };
  }

  if (action.requestGeneration !== state.requestGeneration) return state;
  if (action.type === "hydration-failed") {
    const statuses = new Map(state.statusByKey);
    for (const asin of action.asins) {
      statuses.set(manualVocOverlayKey(action.scope.organizationId, action.scope.marketplace, asin), "source-error");
    }
    return { ...state, statusByKey: statuses };
  }

  const overlay = new Map(state.overlay);
  const statuses = new Map(state.statusByKey);
  const requested = new Set(action.requestedAsins.map(asin => asin.trim().toUpperCase()));
  const returned = new Set<string>();
  for (const record of action.records) {
    if (!requested.has(record.asin)) continue;
    returned.add(record.asin);
    mergeRecord(state, overlay, statuses, action.scope, record);
  }
  for (const asin of requested) {
    if (returned.has(asin)) continue;
    const key = manualVocOverlayKey(action.scope.organizationId, action.scope.marketplace, asin);
    statuses.set(key, overlay.has(key) ? "ready" : "missing");
  }
  return { ...state, overlay, statusByKey: statuses };
}

export function selectEffectiveVocByAsin(
  state: ManualVocOverlayState,
  organizationId: string,
  marketplace: ManualVocMarketplace,
  asin: string,
): OverlayRecord | null {
  if (state.organizationId !== organizationId || marketplace !== "US") return null;
  const record = state.overlay.get(manualVocOverlayKey(organizationId, marketplace, asin)) ?? null;
  return record?.sessionOrgEpoch === state.sessionOrgEpoch ? record : null;
}
