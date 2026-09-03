import assert from "node:assert/strict";
import test from "node:test";

import { readAlexaVocNormalizationStatuses } from "../../app/lib/alexa-voc-normalization-status-client";

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
