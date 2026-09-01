import assert from "node:assert/strict";
import test from "node:test";

import type { ManualAlexaVocRecord } from "../../shared/agent-contracts";
import {
  createManualVocOverlayState,
  abortManualVocRequests,
  hydrationFailed,
  hydrationStarted,
  hydrationSucceeded,
  identityChanged,
  importSucceeded,
  manualVocOverlayKey,
  reduceManualVoc,
  selectEffectiveVocByAsin,
  initialAlexaVocState,
  reduceAlexaVocState,
  reduceAlexaVocStatusResponse,
  selectAlexaVocStatus,
  selectPageBlockingLoading,
  selectPendingAlexaVocPolls,
  abortAlexaVocPollsOutsideScope,
} from "../../app/manual-alexa-voc-store";

const ASIN = "B0T2TASK11";
const OTHER_ASIN = "B07VY9Q95Q";
const THIRD_ASIN = "B0BPXRVWYK";
const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "20000000-0000-4000-8000-000000000001";
const PROJECT_ID = "10000000-0000-4000-8000-000000000010";
const RUN_ID = "10000000-0000-4000-8000-000000000011";

function record(
  revision: string,
  attention = `attention-${revision}`,
  options: Partial<ManualAlexaVocRecord> & Readonly<{ asin?: string }> = {},
): ManualAlexaVocRecord {
  const asin = options.asin ?? ASIN;
  return {
    asin,
    marketplace: "US",
    revision,
    contentHash: `${revision.slice(-1).padStart(1, "0")}`.repeat(64),
    source: "postgres",
    generation: revision,
    capturedAt: `2026-08-31T01:02:0${Math.min(Number(revision), 9)}.456Z`,
    normalizedRecord: {
      asin,
      attention: [attention],
      positives: ["reliable"],
      negatives: ["packaging"],
      unmet: [],
      audiences: [],
      scenarios: [],
      motives: [],
      captureStatus: "dialog",
      alexaReport: {
        title: "Customer review analysis",
        asin,
        rating: 4.5,
        reviewCount: 100,
        prompt: "Seven-question prompt",
        overallConclusion: "Imported",
        captureStatus: "dialog",
      },
    },
    ...options,
  };
}

const scope = (organizationId = ORG_A) => ({ organizationId, marketplace: "US" as const });
const context = (requestGeneration: number, organizationId = ORG_A, sessionOrgEpoch = 1) => ({
  sessionOrgEpoch,
  requestGeneration,
  scope: scope(organizationId),
});

test("tenant keys and selectors never expose a record through another organization or marketplace", () => {
  let state = createManualVocOverlayState("session-a", ORG_A);
  state = reduceManualVoc(state, importSucceeded({ ...context(1), record: record("1") }));

  assert.equal(manualVocOverlayKey(ORG_A, "US", ASIN), `${ORG_A}:US:${ASIN}`);
  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", ASIN)?.revision, "1");
  assert.equal(selectEffectiveVocByAsin(state, ORG_B, "US", ASIN), null);
  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "CA" as "US", ASIN), null);
});

test("POST success is visible immediately and an older GET cannot overwrite it", () => {
  let state = createManualVocOverlayState("session-a", ORG_A);
  state = reduceManualVoc(state, importSucceeded({ ...context(2), record: record("4") }));
  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", ASIN)?.revision, "4");

  state = reduceManualVoc(state, hydrationSucceeded({
    ...context(1),
    requestedAsins: [ASIN],
    records: [record("3")],
  }));
  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", ASIN)?.revision, "4");
});

test("an accepted newer request still cannot replace a higher overlay revision", () => {
  let state = createManualVocOverlayState("session-a", ORG_A);
  state = reduceManualVoc(state, importSucceeded({ ...context(1), record: record("4") }));
  state = reduceManualVoc(state, hydrationStarted({ ...context(2), asins: [ASIN] }));
  state = reduceManualVoc(state, hydrationSucceeded({
    ...context(2),
    requestedAsins: [ASIN],
    records: [record("3")],
  }));

  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", ASIN)?.revision, "4");
  assert.equal(state.statusByKey.get(manualVocOverlayKey(ORG_A, "US", ASIN)), "ready");
});

test("same revision is idempotent only for the same content hash and conflicts even when visible content matches", () => {
  let state = createManualVocOverlayState("session-a", ORG_A);
  state = reduceManualVoc(state, importSucceeded({ ...context(1), record: record("4") }));
  state = reduceManualVoc(state, hydrationSucceeded({
    ...context(1),
    requestedAsins: [ASIN],
    records: [record("4", "different-visible-content")],
  }));
  assert.equal(state.statusByKey.get(manualVocOverlayKey(ORG_A, "US", ASIN)), "ready");

  state = reduceManualVoc(state, hydrationSucceeded({
    ...context(1),
    requestedAsins: [ASIN],
    records: [record("4", "attention-4", { contentHash: "f".repeat(64) })],
  }));
  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", ASIN)?.normalizedRecord.attention[0], "attention-4");
  assert.equal(state.statusByKey.get(manualVocOverlayKey(ORG_A, "US", ASIN)), "protocol-conflict");
});

test("a newer single-ASIN confirmation does not discard other ASINs from an older batch", () => {
  let state = createManualVocOverlayState("session-a", ORG_A);
  state = reduceManualVoc(state, hydrationStarted({ ...context(1), asins: [ASIN, OTHER_ASIN, THIRD_ASIN] }));
  state = reduceManualVoc(state, importSucceeded({ ...context(2), record: record("4") }));
  state = reduceManualVoc(state, hydrationStarted({ ...context(3), asins: [ASIN] }));

  state = reduceManualVoc(state, hydrationSucceeded({
    ...context(1),
    requestedAsins: [ASIN, OTHER_ASIN, THIRD_ASIN],
    records: [
      record("3"),
      record("1", undefined, { asin: OTHER_ASIN }),
      record("1", undefined, { asin: THIRD_ASIN }),
    ],
  }));

  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", ASIN)?.revision, "4");
  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", OTHER_ASIN)?.asin, OTHER_ASIN);
  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", THIRD_ASIN)?.asin, THIRD_ASIN);
  assert.equal(state.statusByKey.get(manualVocOverlayKey(ORG_A, "US", OTHER_ASIN)), "ready");
  assert.equal(state.statusByKey.get(manualVocOverlayKey(ORG_A, "US", THIRD_ASIN)), "ready");

  state = reduceManualVoc(state, hydrationSucceeded({
    ...context(3),
    requestedAsins: [ASIN],
    records: [record("4")],
  }));
  assert.equal(state.statusByKey.get(manualVocOverlayKey(ORG_A, "US", ASIN)), "ready");
});

test("identity changes advance the epoch, clear overlay and status, and reject the old epoch", () => {
  let state = createManualVocOverlayState("session-a", ORG_A);
  state = reduceManualVoc(state, importSucceeded({ ...context(1), record: record("1") }));
  state = reduceManualVoc(state, identityChanged("session-b", ORG_B));

  assert.equal(state.sessionOrgEpoch, 2);
  assert.equal(state.organizationId, ORG_B);
  assert.equal(state.overlay.size, 0);
  assert.equal(state.statusByKey.size, 0);

  state = reduceManualVoc(state, hydrationSucceeded({
    ...context(2, ORG_A, 1),
    requestedAsins: [ASIN],
    records: [record("9")],
  }));
  state = reduceManualVoc(state, importSucceeded({ ...context(3, ORG_A, 1), record: record("10") }));
  assert.equal(state.overlay.size, 0);
});

test("marketplace changes advance the client scope so US to other to US cannot restore the old US overlay", () => {
  let state = createManualVocOverlayState("session-a", ORG_A, 1, "US");
  state = reduceManualVoc(state, importSucceeded({ ...context(1), record: record("1") }));

  state = reduceManualVoc(state, identityChanged("session-a", ORG_A, "CA"));
  assert.equal(state.sessionOrgEpoch, 2);
  assert.equal(state.marketplace, "CA");
  assert.equal(state.overlay.size, 0);
  assert.equal(state.statusByKey.size, 0);
  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", ASIN), null);

  state = reduceManualVoc(state, identityChanged("session-a", ORG_A, "US"));
  assert.equal(state.sessionOrgEpoch, 3);
  assert.equal(state.marketplace, "US");
  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", ASIN), null);
});

test("organization, marketplace, and request-generation mismatches are dropped", () => {
  let state = createManualVocOverlayState("session-a", ORG_A);
  state = reduceManualVoc(state, hydrationStarted({ ...context(2), asins: [ASIN] }));

  for (const action of [
    hydrationSucceeded({ ...context(2, ORG_B), requestedAsins: [ASIN], records: [record("2")] }),
    hydrationSucceeded({ ...context(1), requestedAsins: [ASIN], records: [record("2")] }),
    hydrationSucceeded({
      ...context(2),
      scope: { organizationId: ORG_A, marketplace: "CA" as "US" },
      requestedAsins: [ASIN],
      records: [record("2")],
    }),
  ]) state = reduceManualVoc(state, action);

  assert.equal(state.overlay.size, 0);
  assert.equal(state.statusByKey.get(manualVocOverlayKey(ORG_A, "US", ASIN)), "loading");
});

test("loading, missing, and source-error states are stable while errors preserve newer overlay", () => {
  let state = createManualVocOverlayState("session-a", ORG_A);
  state = reduceManualVoc(state, hydrationStarted({ ...context(1), asins: [ASIN, OTHER_ASIN] }));
  assert.equal(state.statusByKey.get(manualVocOverlayKey(ORG_A, "US", OTHER_ASIN)), "loading");

  state = reduceManualVoc(state, hydrationSucceeded({
    ...context(1),
    requestedAsins: [ASIN, OTHER_ASIN],
    records: [record("1")],
  }));
  assert.equal(state.statusByKey.get(manualVocOverlayKey(ORG_A, "US", OTHER_ASIN)), "missing");

  state = reduceManualVoc(state, hydrationStarted({ ...context(2), asins: [ASIN] }));
  state = reduceManualVoc(state, hydrationFailed({ ...context(2), asins: [ASIN] }));
  assert.equal(selectEffectiveVocByAsin(state, ORG_A, "US", ASIN)?.revision, "1");
  assert.equal(state.statusByKey.get(manualVocOverlayKey(ORG_A, "US", ASIN)), "source-error");
});

test("identity teardown aborts and clears every in-flight Manual VOC request", () => {
  const first = new AbortController();
  const second = new AbortController();
  const requests = new Map([[1, first], [2, second]]);

  abortManualVocRequests(requests);

  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(requests.size, 0);
});

test("keeps sibling ASIN and non-VOC modules interactive while one normalization record fails", () => {
  const state = reduceAlexaVocState(initialAlexaVocState, [
    { type: "setPending", projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: "a".repeat(64) },
    { type: "setFailure", projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: "a".repeat(64), error: "model-output" },
    { type: "setSuccess", projectId: PROJECT_ID, runId: RUN_ID, asin: OTHER_ASIN, fingerprint: "b".repeat(64), revision: "2" },
  ]);
  assert.equal(selectAlexaVocStatus(state, PROJECT_ID, RUN_ID, ASIN)?.status, "failure");
  assert.equal(selectAlexaVocStatus(state, PROJECT_ID, RUN_ID, OTHER_ASIN)?.status, "success");
  assert.equal(selectPageBlockingLoading(state), false);
});

test("an old fingerprint cannot overwrite a newer pending status", () => {
  const oldFingerprint = "a".repeat(64);
  const nextFingerprint = "b".repeat(64);
  const state = reduceAlexaVocState(initialAlexaVocState, [
    { type: "setPending", projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: oldFingerprint },
    { type: "setPending", projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: nextFingerprint },
    { type: "setSuccess", projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: oldFingerprint, revision: "1" },
  ]);
  assert.deepEqual(selectAlexaVocStatus(state, PROJECT_ID, RUN_ID, ASIN), {
    asin: ASIN,
    fingerprint: nextFingerprint,
    status: "pending",
    revision: null,
    error: null,
  });
  assert.deepEqual(selectPendingAlexaVocPolls(state, PROJECT_ID, RUN_ID).map((record) => record.asin), [ASIN]);
});

test("a protected import success replaces an older failure while its old poll stays stale", () => {
  const oldFingerprint = "a".repeat(64);
  const nextFingerprint = "b".repeat(64);
  let state = reduceAlexaVocState(initialAlexaVocState, [
    { type: "setPending", projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: oldFingerprint },
    { type: "setFailure", projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: oldFingerprint, error: "model-output" },
  ]);

  state = reduceAlexaVocState(state, {
    type: "replaceWithImportSuccess",
    projectId: PROJECT_ID,
    runId: RUN_ID,
    asin: ASIN,
    fingerprint: nextFingerprint,
    revision: "2",
  });
  state = reduceAlexaVocStatusResponse(state, { projectId: PROJECT_ID, runId: RUN_ID }, {
    records: [{
      asin: ASIN,
      fingerprint: oldFingerprint,
      status: "success",
      revision: "1",
      error: null,
    }],
  });

  assert.deepEqual(selectAlexaVocStatus(state, PROJECT_ID, RUN_ID, ASIN), {
    asin: ASIN,
    fingerprint: nextFingerprint,
    status: "success",
    revision: "2",
    error: null,
  });
});

test("only pending cards poll and a scope change aborts the old poll", () => {
  const state = reduceAlexaVocState(initialAlexaVocState, [
    { type: "setPending", projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: "a".repeat(64) },
    { type: "setFailure", projectId: PROJECT_ID, runId: RUN_ID, asin: OTHER_ASIN, fingerprint: "b".repeat(64), error: "schema" },
  ]);
  assert.deepEqual(selectPendingAlexaVocPolls(state, PROJECT_ID, RUN_ID).map((record) => record.asin), [ASIN]);
  const active = new AbortController();
  const next = new AbortController();
  const polls = new Map([
    [`${PROJECT_ID}:${RUN_ID}:${ASIN}`, active],
    [`other:run:${OTHER_ASIN}`, next],
  ]);
  abortAlexaVocPollsOutsideScope(polls, { projectId: PROJECT_ID, runId: RUN_ID });
  assert.equal(active.signal.aborted, false);
  assert.equal(next.signal.aborted, true);
});
