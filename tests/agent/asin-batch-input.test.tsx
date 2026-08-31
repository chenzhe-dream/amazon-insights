import assert from "node:assert/strict";
import test from "node:test";

import type { ReactElement, ReactNode } from "react";

import { BatchAsinInput } from "../../app/batch-asin-input";
import { parseBatchAsinInput } from "../../app/lib/asin-batch-input";

test("parses mixed delimiters, uppercases, preserves order, and reports duplicates", () => {
  const result = parseBatchAsinInput("b0aaaa0001\nB0BBBB0002，B0AAAA0001;B0CCCC0003");

  assert.deepEqual(result.asins, ["B0AAAA0001", "B0BBBB0002", "B0CCCC0003"]);
  assert.deepEqual(result.duplicates, ["B0AAAA0001"]);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.overflow, []);
  assert.equal(result.canSubmit, false);
});

test("supports every documented separator without changing first-seen order", () => {
  const result = parseBatchAsinInput("b0aaaa0001 B0BBBB0002,B0CCCC0003、B0DDDD0004；B0EEEE0005|B0FFFF0006");

  assert.deepEqual(result.asins, [
    "B0AAAA0001",
    "B0BBBB0002",
    "B0CCCC0003",
    "B0DDDD0004",
    "B0EEEE0005",
    "B0FFFF0006",
  ]);
  assert.equal(result.canSubmit, true);
});

test("reports invalid and overflow tokens without truncating silently", () => {
  const attemptedAsins = Array.from({ length: 11 }, (_, i) => `B${String(i).padStart(9, "0")}`);
  const raw = [...attemptedAsins, "bad"].join(" ");
  const result = parseBatchAsinInput(raw);

  assert.deepEqual(result.asins, []);
  assert.deepEqual(result.overflow, attemptedAsins);
  assert.deepEqual(result.invalid, ["BAD"]);
  assert.equal(result.canSubmit, false);
});

test("rejects an eleven-ASIN attempt without accepting a truncated scope", () => {
  const attemptedAsins = Array.from({ length: 11 }, (_, i) => `B${String(i).padStart(9, "0")}`);
  const result = parseBatchAsinInput(attemptedAsins.join("\n"));

  assert.equal(result.canSubmit, false);
  assert.deepEqual(result.asins, []);
  assert.deepEqual(result.overflow, attemptedAsins);
});

test("requires at least three unique valid ASINs before submission", () => {
  const result = parseBatchAsinInput("B0AAAA0001\nB0BBBB0002");

  assert.deepEqual(result.asins, ["B0AAAA0001", "B0BBBB0002"]);
  assert.equal(result.canSubmit, false);
});

test("controlled editor keeps raw invalid text visible and renders separate diagnostics", () => {
  const raw = [
    ...Array.from({ length: 11 }, (_, i) => `B${String(i).padStart(9, "0")}`),
    "B000000000",
    "bad-token",
  ].join("\n");
  const result = parseBatchAsinInput(raw);
  let changedRaw = "";
  const element = BatchAsinInput({
    raw,
    result,
    onRawChange: value => {
      changedRaw = value;
    },
  });
  const children = element.props.children as ReactElement<{
    "aria-label"?: string;
    children?: ReactNode;
    onChange?: (event: { target: { value: string } }) => void;
    role?: string;
    value?: string;
  }>[];
  const textarea = children[0]!;
  const summary = children[1]!;
  const alerts = children.slice(2).filter(child => child?.props.role === "alert");
  const textOf = (child: ReactElement<{ children?: ReactNode }>) =>
    (Array.isArray(child.props.children) ? child.props.children : [child.props.children]).join("");

  assert.equal(textarea.props["aria-label"], "批量输入 ASIN");
  assert.equal(textarea.props.value, raw);
  textarea.props.onChange?.({ target: { value: `${raw}\nstill-invalid` } });
  assert.equal(changedRaw, `${raw}\nstill-invalid`);
  assert.equal(textOf(summary), "已识别 0/10 个");
  assert.deepEqual(alerts.map(textOf), [
    "格式错误：BAD-TOKEN",
    "重复 ASIN：B000000000",
    `最多 10 个，超出：${Array.from({ length: 11 }, (_, i) => `B${String(i).padStart(9, "0")}`).join("、")}`,
  ]);
});
