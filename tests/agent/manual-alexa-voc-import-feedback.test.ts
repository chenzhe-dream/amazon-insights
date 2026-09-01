import assert from "node:assert/strict";
import test from "node:test";

import { manualAlexaVocImportErrorMessage } from "../../app/lib/manual-alexa-voc-import-feedback";
import {
  initialAlexaVocImportFeedbackState,
  reduceAlexaVocImportFeedback,
  selectAlexaVocImportFeedback,
} from "../../app/manual-alexa-voc-store";

const PROJECT_ID = "10000000-0000-4000-8000-000000000010";
const RUN_ID = "10000000-0000-4000-8000-000000000011";
const ASIN_A = "B0T2TASK11";
const ASIN_B = "B07VY9Q95Q";

test("HTTP 422 renders actionable Chinese copy instead of a structured error object", () => {
  assert.equal(
    manualAlexaVocImportErrorMessage(422, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Alexa report is incomplete or invalid",
      },
    }),
    "导入失败：请确认报告包含当前 ASIN，并至少包含 3 个标准维度标题。",
  );
});

test("unknown structured errors stay bounded and never render object coercion or secrets", () => {
  const message = manualAlexaVocImportErrorMessage(500, {
    error: { secret: "must-not-render" },
  });

  assert.equal(message, "导入失败");
  assert.doesNotMatch(message, /\[object Object\]|must-not-render/);
});

test("safe legacy string errors remain readable", () => {
  assert.equal(
    manualAlexaVocImportErrorMessage(409, { error: "当前 ASIN 已存在较新版本" }),
    "当前 ASIN 已存在较新版本",
  );
});

test("import feedback belongs only to its project run and ASIN card", () => {
  const scopeA = { projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN_A };
  let state = reduceAlexaVocImportFeedback(initialAlexaVocImportFeedbackState, {
    type: "started",
    ...scopeA,
  });

  assert.equal(selectAlexaVocImportFeedback(state, PROJECT_ID, RUN_ID, ASIN_A).status, "loading");
  assert.deepEqual(selectAlexaVocImportFeedback(state, PROJECT_ID, RUN_ID, ASIN_B), {
    status: "idle",
    message: "",
    preview: [],
  });

  state = reduceAlexaVocImportFeedback(state, {
    type: "succeeded",
    ...scopeA,
    message: "已安全提交，正在等待 Alexa VOC 标准化处理",
    preview: ["A-only preview"],
  });
  const pendingOnB = selectAlexaVocImportFeedback(state, PROJECT_ID, RUN_ID, ASIN_B);
  assert.equal(pendingOnB.status === "loading", false);
  assert.equal(pendingOnB.message, "");
  assert.deepEqual(pendingOnB.preview, []);

  state = reduceAlexaVocImportFeedback(state, {
    type: "failed",
    ...scopeA,
    message: "A-only failure",
  });
  const failureOnB = selectAlexaVocImportFeedback(state, PROJECT_ID, RUN_ID, ASIN_B);
  assert.equal(failureOnB.status === "loading", false);
  assert.equal(failureOnB.message, "");
  assert.deepEqual(failureOnB.preview, []);
});
