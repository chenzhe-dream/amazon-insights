import type {
  AlexaVocNormalizationStatus,
  AlexaVocNormalizationStatusResponse,
  ManualAlexaVocRecord,
} from "../shared/agent-contracts";

export type AlexaVocNormalizationClientState = Readonly<{
  statusByCard: ReadonlyMap<string, AlexaVocNormalizationStatus>;
}>;

type AlexaVocNormalizationAction =
  | Readonly<{ type: "setPending"; projectId: string; runId: string; asin: string; fingerprint: string }>
  | Readonly<{ type: "setSuccess"; projectId: string; runId: string; asin: string; fingerprint: string; revision: string }>
  | Readonly<{ type: "replaceWithImportSuccess"; projectId: string; runId: string; asin: string; fingerprint: string; revision: string }>
  | Readonly<{ type: "setFailure"; projectId: string; runId: string; asin: string; fingerprint: string; error: NonNullable<AlexaVocNormalizationStatus["error"]> }>
  | Readonly<{ type: "clear"; projectId: string; runId: string; asin: string; fingerprint?: string }>;

export const initialAlexaVocState: AlexaVocNormalizationClientState = Object.freeze({
  statusByCard: new Map(),
});

export const alexaVocCardKey = (projectId: string, runId: string, asin: string) =>
  `${projectId}:${runId}:${asin.trim().toUpperCase()}`;

export function reduceAlexaVocState(
  state: AlexaVocNormalizationClientState,
  actionOrActions: AlexaVocNormalizationAction | readonly AlexaVocNormalizationAction[],
): AlexaVocNormalizationClientState {
  const actions = Array.isArray(actionOrActions) ? actionOrActions : [actionOrActions];
  const statusByCard = new Map(state.statusByCard);
  for (const action of actions) {
    const key = alexaVocCardKey(action.projectId, action.runId, action.asin);
    const current = statusByCard.get(key);
    if (action.type === "clear") {
      if (action.fingerprint === undefined || current?.fingerprint === action.fingerprint) statusByCard.delete(key);
      continue;
    }
    if (
      action.type !== "setPending"
      && action.type !== "replaceWithImportSuccess"
      && current
      && current.fingerprint !== action.fingerprint
    ) continue;
    statusByCard.set(key, action.type === "setPending"
      ? { asin: action.asin, fingerprint: action.fingerprint, status: "pending", revision: null, error: null }
      : action.type === "setSuccess" || action.type === "replaceWithImportSuccess"
        ? { asin: action.asin, fingerprint: action.fingerprint, status: "success", revision: action.revision, error: null }
        : { asin: action.asin, fingerprint: action.fingerprint, status: "failure", revision: null, error: action.error });
  }
  return { statusByCard };
}

export function reduceAlexaVocStatusResponse(
  state: AlexaVocNormalizationClientState,
  scope: Readonly<{ projectId: string; runId: string }>,
  response: AlexaVocNormalizationStatusResponse,
) {
  return reduceAlexaVocState(state, response.records.flatMap((record): AlexaVocNormalizationAction[] => {
    const current = selectAlexaVocStatus(state, scope.projectId, scope.runId, record.asin);
    if (current && current.fingerprint !== record.fingerprint) return [];
    return [
    record.status === "pending"
      ? { type: "setPending", ...scope, asin: record.asin, fingerprint: record.fingerprint }
      : record.status === "success"
        ? { type: "setSuccess", ...scope, asin: record.asin, fingerprint: record.fingerprint, revision: record.revision! }
        : { type: "setFailure", ...scope, asin: record.asin, fingerprint: record.fingerprint, error: record.error! },
    ];
  }));
}

export function selectAlexaVocStatus(
  state: AlexaVocNormalizationClientState,
  projectId: string,
  runId: string,
  asin: string,
) {
  return state.statusByCard.get(alexaVocCardKey(projectId, runId, asin));
}

export function selectPendingAlexaVocPolls(
  state: AlexaVocNormalizationClientState,
  projectId: string,
  runId: string,
) {
  const prefix = `${projectId}:${runId}:`;
  return [...state.statusByCard.entries()]
    .filter(([key, record]) => key.startsWith(prefix) && record.status === "pending")
    .map(([, record]) => record);
}

export function selectPageBlockingLoading(_state: AlexaVocNormalizationClientState) {
  void _state;
  return false;
}

export function abortAlexaVocPollsOutsideScope(
  polls: Map<string, AbortController>,
  scope: Readonly<{ projectId: string; runId: string }>,
) {
  const prefix = `${scope.projectId}:${scope.runId}:`;
  for (const [key, controller] of polls) {
    if (key.startsWith(prefix)) continue;
    controller.abort();
    polls.delete(key);
  }
}

export type AlexaVocImportFeedback = Readonly<{
  status: "idle" | "loading" | "done" | "error";
  message: string;
  preview: readonly string[];
  pendingFingerprint?: string;
}>;

export type AlexaVocImportFeedbackState = Readonly<{
  feedbackByCard: ReadonlyMap<string, AlexaVocImportFeedback>;
}>;

type AlexaVocImportFeedbackScope = Readonly<{
  projectId: string;
  runId: string;
  asin: string;
}>;

type AlexaVocImportFeedbackAction =
  | (AlexaVocImportFeedbackScope & Readonly<{ type: "started" }>)
  | (AlexaVocImportFeedbackScope & Readonly<{ type: "succeeded"; message: string; preview?: readonly string[]; pendingFingerprint?: string }>)
  | (AlexaVocImportFeedbackScope & Readonly<{ type: "failed"; message: string }>)
  | (AlexaVocImportFeedbackScope & Readonly<{ type: "cleared"; pendingFingerprint?: string }>);

const idleAlexaVocImportFeedback: AlexaVocImportFeedback = Object.freeze({
  status: "idle",
  message: "",
  preview: Object.freeze([]),
});

export const initialAlexaVocImportFeedbackState: AlexaVocImportFeedbackState = Object.freeze({
  feedbackByCard: new Map(),
});

export function reduceAlexaVocImportFeedback(
  state: AlexaVocImportFeedbackState,
  action: AlexaVocImportFeedbackAction,
): AlexaVocImportFeedbackState {
  const feedbackByCard = new Map(state.feedbackByCard);
  const key = alexaVocCardKey(action.projectId, action.runId, action.asin);
  if (action.type === "cleared") {
    if (
      action.pendingFingerprint === undefined ||
      feedbackByCard.get(key)?.pendingFingerprint === action.pendingFingerprint
    ) feedbackByCard.delete(key);
    return { feedbackByCard };
  }
  feedbackByCard.set(key, action.type === "started"
    ? { status: "loading", message: "", preview: [] }
    : action.type === "succeeded"
      ? {
          status: "done",
          message: action.message,
          preview: action.preview ?? [],
          ...(action.pendingFingerprint === undefined ? {} : { pendingFingerprint: action.pendingFingerprint }),
        }
      : { status: "error", message: action.message, preview: [] });
  return { feedbackByCard };
}

export function selectAlexaVocImportFeedback(
  state: AlexaVocImportFeedbackState,
  projectId: string,
  runId: string,
  asin: string,
): AlexaVocImportFeedback {
  return state.feedbackByCard.get(alexaVocCardKey(projectId, runId, asin)) ?? idleAlexaVocImportFeedback;
}

export type AlexaVocDraftState = Readonly<{
  draftByCard: ReadonlyMap<string, string>;
}>;

export const initialAlexaVocDraftState: AlexaVocDraftState = Object.freeze({
  draftByCard: new Map(),
});

export function setAlexaVocDraft(
  state: AlexaVocDraftState,
  input: Readonly<{ projectId: string; runId: string; asin: string; text: string }>,
): AlexaVocDraftState {
  const draftByCard = new Map(state.draftByCard);
  draftByCard.set(alexaVocCardKey(input.projectId, input.runId, input.asin), input.text);
  return { draftByCard };
}

export function selectAlexaVocDraft(
  state: AlexaVocDraftState,
  projectId: string,
  runId: string,
  asin: string,
) {
  return state.draftByCard.get(alexaVocCardKey(projectId, runId, asin)) ?? "";
}

export function createAlexaVocImportSubmission(input: Readonly<{
  projectId: string;
  runId: string;
  asin: string;
  text: string;
}>) {
  const scope = { projectId: input.projectId, runId: input.runId, asin: input.asin };
  return { scope, request: { ...scope, text: input.text } } as const;
}

export type ManualVocMarketplace = "US";
export type ManualVocStatus = "loading" | "ready" | "missing" | "source-error" | "protocol-conflict";
export type OverlayRecord = ManualAlexaVocRecord & Readonly<{ sessionOrgEpoch: number }>;
export type ManualVocOverlayState = Readonly<{
  identity: string;
  organizationId: string;
  marketplace: string;
  projectId: string | null;
  sessionOrgEpoch: number;
  requestGeneration: number;
  requestGenerationByKey: ReadonlyMap<string, number>;
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
  | Readonly<{ type: "identity-changed"; identity: string; organizationId: string; marketplace: string; projectId: string | null }>
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
  marketplace = "US",
  projectId: string | null = null,
): ManualVocOverlayState {
  return {
    identity,
    organizationId,
    marketplace,
    projectId,
    sessionOrgEpoch,
    requestGeneration: 0,
    requestGenerationByKey: new Map(),
    overlay: new Map(),
    statusByKey: new Map(),
  };
}

export const identityChanged = (identity: string, organizationId: string, marketplace = "US"): ManualVocAction => ({
  type: "identity-changed",
  identity,
  organizationId,
  marketplace,
  projectId: null,
});

export const manualVocScopeChanged = (
  identity: string,
  organizationId: string,
  marketplace: string,
  projectId: string | null,
): ManualVocAction => ({ type: "identity-changed", identity, organizationId, marketplace, projectId });

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
    && action.scope.marketplace === "US"
    && state.marketplace === action.scope.marketplace;
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
  if (order === BigInt(0) && current.contentHash !== incoming.contentHash) {
    statuses.set(key, "protocol-conflict");
    return;
  }
  if (order === BigInt(0)) {
    if (current.source !== "postgres" && incoming.source === "postgres") overlay.set(key, next);
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
    if (
      action.identity === state.identity
      && action.organizationId === state.organizationId
      && action.marketplace === state.marketplace
      && action.projectId === state.projectId
    ) return state;
    return createManualVocOverlayState(
      action.identity,
      action.organizationId,
      state.sessionOrgEpoch + 1,
      action.marketplace,
      action.projectId,
    );
  }
  if (!validScope(state, action)) return state;

  if (action.type === "hydration-started") {
    if (action.requestGeneration <= state.requestGeneration) return state;
    const statuses = new Map(state.statusByKey);
    const requestGenerationByKey = new Map(state.requestGenerationByKey);
    for (const asin of action.asins) {
      const key = manualVocOverlayKey(action.scope.organizationId, action.scope.marketplace, asin);
      requestGenerationByKey.set(key, action.requestGeneration);
      statuses.set(key, "loading");
    }
    return { ...state, requestGeneration: action.requestGeneration, requestGenerationByKey, statusByKey: statuses };
  }

  if (action.type === "import-succeeded") {
    if (action.record.marketplace !== action.scope.marketplace) return state;
    const key = manualVocOverlayKey(action.scope.organizationId, action.scope.marketplace, action.record.asin);
    if (action.requestGeneration < (state.requestGenerationByKey.get(key) ?? 0)) return state;
    const overlay = new Map(state.overlay);
    const statuses = new Map(state.statusByKey);
    const requestGenerationByKey = new Map(state.requestGenerationByKey);
    requestGenerationByKey.set(key, action.requestGeneration);
    mergeRecord(state, overlay, statuses, action.scope, action.record);
    return {
      ...state,
      requestGeneration: Math.max(state.requestGeneration, action.requestGeneration),
      requestGenerationByKey,
      overlay,
      statusByKey: statuses,
    };
  }

  if (action.type === "hydration-failed") {
    const statuses = new Map(state.statusByKey);
    for (const asin of action.asins) {
      const key = manualVocOverlayKey(action.scope.organizationId, action.scope.marketplace, asin);
      if (state.requestGenerationByKey.get(key) === action.requestGeneration) statuses.set(key, "source-error");
    }
    return { ...state, statusByKey: statuses };
  }

  const overlay = new Map(state.overlay);
  const statuses = new Map(state.statusByKey);
  const requested = new Set(action.requestedAsins.map(asin => asin.trim().toUpperCase()));
  const returned = new Set<string>();
  for (const record of action.records) {
    if (!requested.has(record.asin)) continue;
    const key = manualVocOverlayKey(action.scope.organizationId, action.scope.marketplace, record.asin);
    if (state.requestGenerationByKey.get(key) !== action.requestGeneration) continue;
    returned.add(record.asin);
    mergeRecord(state, overlay, statuses, action.scope, record);
  }
  for (const asin of requested) {
    if (returned.has(asin)) continue;
    const key = manualVocOverlayKey(action.scope.organizationId, action.scope.marketplace, asin);
    if (state.requestGenerationByKey.get(key) !== action.requestGeneration) continue;
    statuses.set(key, overlay.has(key) ? "ready" : "missing");
  }
  return { ...state, overlay, statusByKey: statuses };
}

export function selectEffectiveVocByAsin(
  state: ManualVocOverlayState,
  organizationId: string,
  marketplace: ManualVocMarketplace,
  asin: string,
  projectId?: string | null,
): OverlayRecord | null {
  if (
    state.organizationId !== organizationId
    || state.marketplace !== marketplace
    || marketplace !== "US"
    || (projectId !== undefined && state.projectId !== projectId)
  ) return null;
  const record = state.overlay.get(manualVocOverlayKey(organizationId, marketplace, asin)) ?? null;
  return record?.sessionOrgEpoch === state.sessionOrgEpoch ? record : null;
}
