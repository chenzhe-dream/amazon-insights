import assert from "node:assert/strict";
import test from "node:test";

import {
  DingTalkBrowserError,
  DingTalkWorkbenchAttempt,
  isDingTalkContainer,
  requestDingTalkWorkbenchCode,
  sanitizeDingTalkReturnPath,
} from "../../app/lib/dingtalk-browser";

test("DingTalk callback errors are excluded from the next return path", () => {
  assert.equal(
    sanitizeDingTalkReturnPath("/p/project-us-3", "?tab=voc&dingtalk_error=invalid_state"),
    "/p/project-us-3?tab=voc",
  );
  assert.equal(sanitizeDingTalkReturnPath("//evil.example", "?dingtalk_error=x"), "/");
});

test("DingTalk container detection is conservative", () => {
  assert.equal(isDingTalkContainer({ userAgent: "Mozilla DingTalk/7.6.0" }), true);
  assert.equal(isDingTalkContainer({ userAgent: "Mozilla AliApp(DingTalk/7.6.0)" }), true);
  assert.equal(isDingTalkContainer({ userAgent: "Chrome/140 Safari/537.36" }), false);
  assert.equal(isDingTalkContainer(null), false);
});

test("automatic workbench login can be claimed only once per page lifecycle", () => {
  const attempt = new DingTalkWorkbenchAttempt();
  assert.equal(attempt.claim({ enabled: false, navigator: { userAgent: "DingTalk/7.6.0" } }), false);
  assert.equal(attempt.claim({ enabled: true, navigator: { userAgent: "Chrome/140" } }), false);
  assert.equal(attempt.claim({ enabled: true, navigator: { userAgent: "DingTalk/7.6.0" } }), true);
  assert.equal(attempt.claim({ enabled: true, navigator: { userAgent: "DingTalk/7.6.0" } }), false);
});

test("workbench JSAPI requests one authorization code for the configured CorpId", async () => {
  const calls: string[] = [];
  const code = await requestDingTalkWorkbenchCode("corp-id", async () => ({
    runtime: { permission: { requestAuthCode: async ({ corpId }: { corpId: string }) => {
      calls.push(corpId);
      return { code: "workbench-code" };
    } } },
  }));
  assert.equal(code, "workbench-code");
  assert.deepEqual(calls, ["corp-id"]);
});

test("workbench JSAPI exposes only stable cancellation and unavailable failures", async () => {
  for (const [reason, kind] of [
    [{ errorMessage: "user cancel" }, "cancelled"],
    [new Error("secret provider details"), "unavailable"],
    [null, "unavailable"],
  ] as const) {
    await assert.rejects(
      () => requestDingTalkWorkbenchCode("corp-id", async () => ({
        runtime: { permission: { requestAuthCode: async () => { throw reason; } } },
      })),
      (error: unknown) => {
        assert.ok(error instanceof DingTalkBrowserError);
        assert.equal(error.kind, kind);
        assert.doesNotMatch(error.message, /secret provider details/);
        return true;
      },
    );
  }
});
