import assert from "node:assert/strict";
import test from "node:test";

import { parseSorftimeTrend } from "../../scripts/lib/sorftime-trend-parse.mjs";

const expected = [
  { month: "2026-01", value: 12 },
  { month: "2026-02", value: 13 },
];

test("product trends normalize current arrays and legacy strings identically", () => {
  assert.deepEqual(parseSorftimeTrend({ data: ["2026年01月=12", "2026年02月=13"] }), expected);
  assert.deepEqual(parseSorftimeTrend(["2026年01月=12", "2026年02月=13"]), expected);
  assert.deepEqual(parseSorftimeTrend("2026年01月=12,2026年02月=13"), expected);
  assert.deepEqual(parseSorftimeTrend({ data: "2026年01月=12,2026年02月=13" }), expected);
  assert.deepEqual(parseSorftimeTrend({ content: "2026年01月=12,2026年02月=13" }), expected);
});

test("product trends discard malformed entries and keep valid month/value pairs", () => {
  assert.deepEqual(
    parseSorftimeTrend({ data: ["bad", "2026年01月=-1", "2026年02月=13", "2026-03=14"] }),
    [
      { month: "2026-02", value: 13 },
      { month: "2026-03", value: 14 },
    ],
  );
  assert.deepEqual(parseSorftimeTrend({ data: ["bad", "2026年01月=NaN"] }), []);
  assert.deepEqual(parseSorftimeTrend({ data: [] }), []);
  assert.deepEqual(parseSorftimeTrend(null), []);
});
