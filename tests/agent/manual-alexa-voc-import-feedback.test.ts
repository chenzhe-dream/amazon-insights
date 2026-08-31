import assert from "node:assert/strict";
import test from "node:test";

import { manualAlexaVocImportErrorMessage } from "../../app/lib/manual-alexa-voc-import-feedback";

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
