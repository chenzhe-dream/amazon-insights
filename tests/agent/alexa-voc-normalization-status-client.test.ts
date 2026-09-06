import assert from "node:assert/strict";
import test from "node:test";

import {
  pollAlexaVocNormalizationOnce,
  readAlexaVocNormalizationStatuses,
} from "../../app/lib/alexa-voc-normalization-status-client";

const PROJECT_ID = "10000000-0000-4000-8000-000000000010";
const RUN_ID = "10000000-0000-4000-8000-000000000011";

test("hydrates normalization status for every scoped ASIN after a page remount", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const response = await readAlexaVocNormalizationStatuses({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    asins: ["b099wtn2tr", "B0B95XH99V", "B099WTN2TR"],
    request: async (input, init) => {
      requests.push({ input, init });
      return Response.json({
        records: [
          {
            asin: "B099WTN2TR",
            fingerprint: "a".repeat(64),
            status: "pending",
            revision: null,
            error: null,
          },
        ],
      });
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(
    String(requests[0]?.input),
    `/api/alexa-voc/pending?projectId=${PROJECT_ID}&runId=${RUN_ID}&marketplace=US&asins=B099WTN2TR&asins=B0B95XH99V`,
  );
  assert.equal(requests[0]?.init?.credentials, "same-origin");
  assert.deepEqual(response.records.map(record => record.asin), ["B099WTN2TR"]);
});

test("rejects a failed or malformed status response instead of erasing client state", async () => {
  await assert.rejects(
    readAlexaVocNormalizationStatuses({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      asins: ["B099WTN2TR"],
      request: async () => Response.json({ error: "unavailable" }, { status: 503 }),
    }),
    /Alexa VOC 标准化状态暂不可用/,
  );

  await assert.rejects(
    readAlexaVocNormalizationStatuses({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      asins: ["B099WTN2TR"],
      request: async () => Response.json({ records: [{ asin: "wrong" }] }),
    }),
    /Alexa VOC 标准化状态响应无效/,
  );
});

const ASIN = "B099WTN2TR";
const FINGERPRINT = "a".repeat(64);

test("one poll reports network, non-2xx, and malformed status reads as bounded recoverable GET errors", async () => {
  const cases = [
    async () => { throw new Error("secret network detail"); },
    async () => Response.json({ secret: "must-not-render" }, { status: 503 }),
    async () => Response.json({ records: [{ asin: "wrong" }] }),
  ];
  for (const request of cases) {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const result = await pollAlexaVocNormalizationOnce({
      projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: FINGERPRINT,
      request: async (input, init) => { calls.push({ input, init }); return request(); },
    });
    assert.deepEqual(result, { phase: "recoverable-error", message: "状态读取暂时失败，将继续重试" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.method ?? "GET", "GET");
    assert.doesNotMatch(JSON.stringify(result), /secret|503/);
  }
});

test("a successful status remains applying until the exact revision is readable", async () => {
  const calls: string[] = [];
  const result = await pollAlexaVocNormalizationOnce({
    projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: FINGERPRINT,
    request: async (input) => {
      calls.push(String(input));
      return calls.length === 1
        ? Response.json({ records: [{ asin: ASIN, fingerprint: FINGERPRINT, status: "success", revision: "7", error: null }] })
        : Response.json({ records: [] });
    },
  });
  assert.deepEqual(result, { phase: "applying", revision: "7" });
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, new RegExp(`projectId=${PROJECT_ID}.*runId=${RUN_ID}.*asins=${ASIN}`));
  assert.match(calls[1]!, new RegExp(`projectId=${PROJECT_ID}.*asins=${ASIN}`));
});

test("poll completion requires the request-bound ASIN, fingerprint, and exact revision", async () => {
  const record = {
    asin: ASIN, marketplace: "US" as const, revision: "7", contentHash: FINGERPRINT,
    normalizedRecord: {
      asin: ASIN, attention: [], positives: [], negatives: [], unmet: [], audiences: [], scenarios: [], motives: [],
      captureStatus: "dialog" as const,
      alexaReport: {
        title: "Lamp", asin: ASIN, rating: 4.5, reviewCount: 10,
        prompt: "Seven questions", overallConclusion: "Useful",
      },
    },
    source: "postgres" as const, generation: null, capturedAt: "2026-09-07T08:00:00.000Z",
  };
  const result = await pollAlexaVocNormalizationOnce({
    projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: FINGERPRINT,
    request: async (input) => String(input).includes("/pending?")
      ? Response.json({ records: [
          { asin: "B0B95XH99V", fingerprint: FINGERPRINT, status: "success", revision: "9", error: null },
          { asin: ASIN, fingerprint: FINGERPRINT, status: "success", revision: "7", error: null },
        ] })
      : Response.json({ records: [{ ...record, revision: "6" }, record] }),
  });
  assert.deepEqual(result, { phase: "done", record });
});

test("a missing fingerprint remains processing and a matching terminal failure is explicit", async () => {
  const processing = await pollAlexaVocNormalizationOnce({
    projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: FINGERPRINT,
    request: async () => Response.json({ records: [] }),
  });
  assert.deepEqual(processing, { phase: "processing" });

  const failure = await pollAlexaVocNormalizationOnce({
    projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN, fingerprint: FINGERPRINT,
    request: async () => Response.json({ records: [
      { asin: ASIN, fingerprint: FINGERPRINT, status: "failure", revision: null, error: "schema" },
    ] }),
  });
  assert.deepEqual(failure, { phase: "failure", error: "schema" });
});
