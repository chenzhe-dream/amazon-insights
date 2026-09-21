import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {FeedbackReporter} from "../../app/help-feedback/feedback-reporter";

test("feedback reporter shows name and supports account and legacy ID fallback", () => {
  const render=(item:{actorUserId:string;actorDisplayName?:string|null;actorEmail?:string|null})=>renderToStaticMarkup(createElement(FeedbackReporter,{item}));
  assert.match(render({actorUserId:"user-1",actorDisplayName:"张三",actorEmail:"zhang@example.com"}),/提出人：张三/);
  assert.match(render({actorUserId:"user-1",actorDisplayName:" ",actorEmail:"zhang@example.com"}),/提出人：zhang@example.com/);
  assert.match(render({actorUserId:"user-1"}),/提出人：用户 user-1/);
  assert.doesNotMatch(render({actorUserId:"user-1",actorDisplayName:"<script>"}),/<script>/);
});
