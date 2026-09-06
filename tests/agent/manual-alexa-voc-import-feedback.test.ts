import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { manualAlexaVocImportErrorMessage } from "../../app/lib/manual-alexa-voc-import-feedback";
import { manualAlexaVocPrimaryAsinAdvisory } from "../../app/alexa-voc-import-validation";
import {
  createAlexaVocImportSubmission,
  isAlexaVocWriteResponseForSubmission,
  initialAlexaVocDraftState,
  initialAlexaVocImportFeedbackState,
  initialAlexaVocState,
  reduceAlexaVocImportFeedback,
  reduceAlexaVocState,
  selectCommittedAlexaVocRecordForPoll,
  selectAlexaVocDraft,
  selectAlexaVocImportFeedback,
  selectAlexaVocStatus,
  setAlexaVocDraft,
} from "../../app/manual-alexa-voc-store";

const PROJECT_ID = "10000000-0000-4000-8000-000000000010";
const RUN_ID = "10000000-0000-4000-8000-000000000011";
const ASIN_A = "B0T2TASK11";
const ASIN_B = "B07VY9Q95Q";

test("primary report ASIN advisory ignores prose and stays silent for the selected product", () => {
  assert.equal(
    manualAlexaVocPrimaryAsinAdvisory(
      `SIBRILLE Floor Lamp (${ASIN_A}) — 完整七维顾客分析\nLove how you can turn the brightness up and down.`,
      ASIN_A,
    ),
    null,
  );
  assert.equal(
    manualAlexaVocPrimaryAsinAdvisory(
      "Love how you can turn the brightness up and down.\n顾客关注亮度调节。",
      ASIN_A,
    ),
    null,
  );
});

test("a different primary report ASIN is advisory while the selected target remains explicit", () => {
  assert.equal(
    manualAlexaVocPrimaryAsinAdvisory(
      `Other lamp (${ASIN_B}) — 完整七维顾客分析\n与竞品 B0NORM0001 对比`,
      ASIN_A,
    ),
    `报告标题识别为 ${ASIN_B}；继续导入将写入当前目标 ${ASIN_A}。`,
  );
});

test("HTTP 422 does not claim that LLM-backed imports require fixed headings", () => {
  assert.equal(
    manualAlexaVocImportErrorMessage(422, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Alexa report is incomplete or invalid",
      },
    }),
    "导入失败：报告内容无法处理，请检查粘贴内容后重试。",
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

test("drafts and the captured import request stay bound to the selected ASIN card", () => {
  let drafts = setAlexaVocDraft(initialAlexaVocDraftState, {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    asin: ASIN_A,
    text: "A-only report",
  });

  assert.equal(selectAlexaVocDraft(drafts, PROJECT_ID, RUN_ID, ASIN_B), "");
  drafts = setAlexaVocDraft(drafts, {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    asin: ASIN_B,
    text: "B-only report",
  });
  assert.equal(selectAlexaVocDraft(drafts, PROJECT_ID, RUN_ID, ASIN_A), "A-only report");

  const submission = createAlexaVocImportSubmission({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    asin: ASIN_B,
    text: selectAlexaVocDraft(drafts, PROJECT_ID, RUN_ID, ASIN_B),
  });
  assert.deepEqual(submission, {
    scope: { projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN_B },
    request: { projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN_B, text: "B-only report" },
  });
});

test("an import response can update only the ASIN captured by the submission", () => {
  const submission = createAlexaVocImportSubmission({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    asin: ASIN_A,
    text: "A-only report",
  });
  const response = {
    disposition: "success" as const,
    normalization: { asin: ASIN_B },
    record: { asin: ASIN_B },
  };

  assert.equal(isAlexaVocWriteResponseForSubmission(submission, response), false);
  assert.equal(isAlexaVocWriteResponseForSubmission(submission, {
    ...response,
    normalization: { asin: ASIN_A },
    record: { asin: ASIN_A },
  }), true);
  assert.equal(isAlexaVocWriteResponseForSubmission(submission, {
    disposition: "pending",
    normalization: { asin: ASIN_A },
    record: null,
  }), true);
});

test("a durable exact-ASIN revision is readable while downstream publication is still pending", () => {
  const records = [
    { asin: ASIN_A, revision: "1", contentHash: "a".repeat(64) },
    { asin: ASIN_B, revision: "1", contentHash: "b".repeat(64) },
  ];

  assert.equal(selectCommittedAlexaVocRecordForPoll(records, {
    asin: ASIN_A,
    fingerprint: "a".repeat(64),
    revision: null,
  }), records[0]);
  assert.equal(selectCommittedAlexaVocRecordForPoll(records, {
    asin: ASIN_A,
    fingerprint: "b".repeat(64),
    revision: null,
  }), undefined);
  assert.equal(selectCommittedAlexaVocRecordForPoll(records, {
    asin: ASIN_A,
    fingerprint: "a".repeat(64),
    revision: "2",
  }), undefined);
});

test("the import panel renders and submits only the selected card draft snapshot", () => {
  const panel = readFileSync("app/alexa-voc-import-panel.tsx", "utf8");
  assert.match(panel, /useState\(initialAlexaVocDraftState\)/);
  assert.match(panel, /selectAlexaVocDraft\([\s\S]*?selectedAsin/);
  assert.match(panel, /manualAlexaVocPrimaryAsinAdvisory\(selectedDraft, selectedAsin\)/);
  assert.match(panel, /className="alexa-voc-import-warning" role="status"/);
  assert.match(panel, /createAlexaVocImportSubmission\([\s\S]*?text: selectedDraft/);
  assert.match(panel, /body: JSON\.stringify\(submission\.request\)/);
  assert.doesNotMatch(panel, /const \[text, setText\] = useState/);
});

test("a rejected stale import clears only its captured card loading and normalization", () => {
  const scopeA = { projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN_A };
  const scopeB = { projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN_B };
  let feedback = reduceAlexaVocImportFeedback(initialAlexaVocImportFeedbackState, {
    type: "started",
    ...scopeA,
  });
  feedback = reduceAlexaVocImportFeedback(feedback, {
    type: "succeeded",
    ...scopeB,
    message: "B remains done",
  });
  let normalization = reduceAlexaVocState(initialAlexaVocState, [
    { type: "setPending", ...scopeA, fingerprint: "a".repeat(64) },
    { type: "setFailure", ...scopeB, fingerprint: "b".repeat(64), error: "schema" },
  ]);

  feedback = reduceAlexaVocImportFeedback(feedback, { type: "cleared", ...scopeA });
  normalization = reduceAlexaVocState(normalization, { type: "clear", ...scopeA });

  assert.deepEqual(selectAlexaVocImportFeedback(feedback, PROJECT_ID, RUN_ID, ASIN_A), {
    status: "idle",
    message: "",
    preview: [],
  });
  assert.equal(selectAlexaVocStatus(normalization, PROJECT_ID, RUN_ID, ASIN_A), undefined);
  assert.equal(selectAlexaVocImportFeedback(feedback, PROJECT_ID, RUN_ID, ASIN_B).message, "B remains done");
  assert.equal(selectAlexaVocStatus(normalization, PROJECT_ID, RUN_ID, ASIN_B)?.status, "failure");
});

test("the panel terminates captured feedback and normalization when onImported rejects", () => {
  const panel = readFileSync("app/alexa-voc-import-panel.tsx", "utf8");
  const rejected = panel.slice(panel.indexOf("if (!onImported(imported))"), panel.indexOf("const lines =", panel.indexOf("if (!onImported(imported))")));
  assert.match(rejected, /type: "cleared"/);
  assert.match(rejected, /type: "clear"/);
  assert.match(rejected, /\.\.\.feedbackScope/);
});

test("normalization keeps polling until its exact durable revision is readable and applied", () => {
  const panel = readFileSync("app/alexa-voc-import-panel.tsx", "utf8");
  const polling = panel.slice(
    panel.indexOf("const observed = await pollAlexaVocNormalizationOnce"),
    panel.indexOf("await waitForPoll(controller.signal);", panel.indexOf("const observed = await pollAlexaVocNormalizationOnce")) + 42,
  );

  assert.match(polling, /pollAlexaVocNormalizationOnce/);
  assert.match(polling, /observed\.phase === "done"/);
  assert.match(polling, /await waitForPoll\(controller\.signal\)/);
});

test("pending UI names its target and truthful phase with accessible indeterminate progress", () => {
  const panel = readFileSync("app/alexa-voc-import-panel.tsx", "utf8");
  assert.match(panel, /role="progressbar"/);
  assert.match(panel, /aria-label={`Alexa VOC 导入进度，目标 \$\{selectedAsin\}`}/);
  assert.match(panel, /正在标准化处理/);
  assert.match(panel, /正在应用 revision/);
  assert.match(panel, /已等待/);
  assert.match(panel, /当前已有版本：revision/);
  assert.match(panel, /捕获于/);
  assert.match(panel, /立即重试状态读取/);
  assert.doesNotMatch(panel, /aria-valuenow|导入进度[^\n]*%/);
});

test("a polled normalization failure clears stale waiting feedback while retaining the failure card", () => {
  const panel = readFileSync("app/alexa-voc-import-panel.tsx", "utf8");
  const polling = panel.slice(panel.indexOf("const observed ="), panel.indexOf("} catch (error)", panel.indexOf("const observed =")));

  assert.match(polling, /observed\.phase === "failure"/);
  assert.match(polling, /setImportFeedbackState\([\s\S]*?type: "cleared"/);
  assert.match(polling, /projectId,\s*runId,\s*asin: record\.asin/);
  assert.match(polling, /pendingFingerprint: record\.fingerprint/);
  assert.match(panel, /normalizationStatus\?\.status === "failure"/);
});

test("pending feedback ignores a stale fingerprint failure but clears the current failure", () => {
  const scope = { projectId: PROJECT_ID, runId: RUN_ID, asin: ASIN_A };
  const fingerprintA = "a".repeat(64);
  const fingerprintB = "b".repeat(64);
  let feedback = reduceAlexaVocImportFeedback(initialAlexaVocImportFeedbackState, {
    type: "succeeded",
    ...scope,
    message: "正在等待 A",
    pendingFingerprint: fingerprintA,
  });
  feedback = reduceAlexaVocImportFeedback(feedback, {
    type: "succeeded",
    ...scope,
    message: "正在等待 B",
    pendingFingerprint: fingerprintB,
  });
  let normalization = reduceAlexaVocState(initialAlexaVocState, [
    { type: "setPending", ...scope, fingerprint: fingerprintA },
    { type: "setPending", ...scope, fingerprint: fingerprintB },
  ]);

  feedback = reduceAlexaVocImportFeedback(feedback, {
    type: "cleared",
    ...scope,
    pendingFingerprint: fingerprintA,
  });
  normalization = reduceAlexaVocState(normalization, {
    type: "setFailure",
    ...scope,
    fingerprint: fingerprintA,
    error: "schema",
  });
  assert.equal(selectAlexaVocImportFeedback(feedback, PROJECT_ID, RUN_ID, ASIN_A).message, "正在等待 B");
  assert.equal(selectAlexaVocStatus(normalization, PROJECT_ID, RUN_ID, ASIN_A)?.fingerprint, fingerprintB);
  assert.equal(selectAlexaVocStatus(normalization, PROJECT_ID, RUN_ID, ASIN_A)?.status, "pending");

  feedback = reduceAlexaVocImportFeedback(feedback, {
    type: "cleared",
    ...scope,
    pendingFingerprint: fingerprintB,
  });
  normalization = reduceAlexaVocState(normalization, {
    type: "setFailure",
    ...scope,
    fingerprint: fingerprintB,
    error: "schema",
  });
  assert.equal(selectAlexaVocImportFeedback(feedback, PROJECT_ID, RUN_ID, ASIN_A).message, "");
  assert.equal(selectAlexaVocStatus(normalization, PROJECT_ID, RUN_ID, ASIN_A)?.status, "failure");
});
