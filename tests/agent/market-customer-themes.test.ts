import assert from "node:assert/strict";
import test from "node:test";
import type {
  AggregateCustomerThemesInput,
  CustomerSourceTheme,
  CustomerThemeSource,
  CustomerThemesAsinInput,
} from "../../server/domain/market-research/customer-themes";

const asin = (index: number) => `B${String(index).padStart(9, "0")}`;
const source = (index = 1): CustomerThemeSource => ({
  sourceRecordId: `response-${index}`, fetchedAt: "2026-09-12T01:00:00.000Z", sourceUpdatedAt: null,
});
const theme = (sourceThemeId: string, patch: Partial<CustomerSourceTheme> = {}): CustomerSourceTheme => ({
  sourceThemeId, keyword: sourceThemeId, content: `source content ${sourceThemeId}`,
  mention: 10, positive: 4, negative: 3, ...patch,
});
const success = (index = 1, themes: CustomerSourceTheme[] = [theme("t1")]): CustomerThemesAsinInput => ({
  asin: asin(index), status: "success", source: source(index), themes,
});
const input = (patch: Partial<AggregateCustomerThemesInput> = {}): AggregateCustomerThemesInput => ({
  selectedAsins: [asin(1)], results: [success()], mappings: [], ...patch,
});
async function api() {
  try { return await import("../../server/domain/market-research/customer-themes"); }
  catch (error) { assert.fail(`Customers Say implementation is required: ${(error as NodeJS.ErrnoException).code}`); }
}
const mergedInput = (): AggregateCustomerThemesInput => input({
  selectedAsins: [asin(1), asin(2)],
  results: [
    success(1, [theme("t1", { mention: 20, positive: 15, negative: 8 }), theme("t2", { mention: 30, positive: 0, negative: 7 })]),
    success(2, [theme("t3", { mention: 50, positive: 0, negative: 10 })]),
  ], mappings: [{ sourceThemeId: "t1", groupId: "lighting" }, { sourceThemeId: "t3", groupId: "lighting" }],
});

test("mapped groups sum original counts against the full successful subset while preserving per-ASIN evidence", async () => {
  const { aggregateCustomerThemes } = await api();
  const result = aggregateCustomerThemes(mergedInput());
  assert.equal(result.metricKind, "customers_say_topic_share");
  assert.equal(result.sentimentOverlap, "not_assumed_disjoint");
  assert.equal(result.dataReady, true);
  assert.equal(result.coverage.status, "complete");
  assert.deepEqual(result.totals, { mention: 100, positive: 15, negative: 25, themeCount: 3 });
  assert.equal(result.groups[0].groupId, "lighting");
  assert.deepEqual(result.groups[0].totals, { mention: 70, positive: 15, negative: 18, themeCount: 2 });
  assert.deepEqual(result.groups[0].topicShare, {
    metricKind: "customers_say_topic_share", numerator: 70, denominator: 100, valuePct: 70,
    denominatorAsins: [asin(1), asin(2)],
  });
  assert.deepEqual(result.groups[0].members.map((member) => [member.asin, member.sourceRecordId, member.sourceThemeId]), [
    [asin(1), "response-1", "t1"], [asin(2), "response-2", "t3"],
  ]);
  assert.equal(result.perAsin[0].totals?.mention, 50);
  assert.equal(result.perAsin[0].themes[0].topicShare.valuePct, 40);
  assert.deepEqual(result.perAsin[0].themes[0].topicShare.denominatorAsins, [asin(1)]);
  assert.equal(result.perAsin[1].themes[0].topicShare.valuePct, 100);
  assert.equal(JSON.stringify(result).includes('"reviewId"'), false);
});

test("topN truncates only display rows and never rebuilds the share denominator", async () => {
  const { aggregateCustomerThemes } = await api();
  const all = aggregateCustomerThemes(mergedInput());
  const limited = aggregateCustomerThemes({ ...mergedInput(), topN: 1 });
  assert.deepEqual(limited.totals, all.totals);
  assert.deepEqual(limited.perAsin, all.perAsin);
  assert.deepEqual(limited.groups, all.groups.slice(0, 1));
  assert.deepEqual(limited.display, { topN: 1, totalGroupCount: 2, displayedGroupCount: 1, omittedGroupCount: 1 });
  assert.equal(limited.groups[0].topicShare.denominator, 100);
  const hidden = aggregateCustomerThemes({ ...mergedInput(), topN: 0 });
  assert.deepEqual(hidden.groups, []);
  assert.deepEqual(hidden.totals, all.totals);
  assert.equal(hidden.dataReady, true);
  assert.equal(hidden.display.omittedGroupCount, 2);
});

test("complete original mapping assignments remain auditable when all display groups are hidden", async () => {
  const { aggregateCustomerThemes } = await api();
  const original = { ...mergedInput(), mappings: [...mergedInput().mappings].reverse(), topN: 0 };
  const result = aggregateCustomerThemes(original);
  assert.deepEqual(result.mappings, [
    { sourceThemeId: "t1", groupId: "lighting" }, { sourceThemeId: "t3", groupId: "lighting" },
  ]);
  assert.notEqual(result.mappings, original.mappings);
  assert.equal(result.perAsin.flatMap((entry) => entry.themes).length, 3);
});

test("changing mappings recomputes counts and shares from all original themes", async () => {
  const { aggregateCustomerThemes } = await api();
  const remapped = aggregateCustomerThemes({ ...mergedInput(), mappings: [
    { sourceThemeId: "t1", groupId: "changed" }, { sourceThemeId: "t2", groupId: "changed" },
  ] });
  assert.equal(remapped.groups[0].groupId, "changed");
  assert.deepEqual(remapped.groups[0].totals, { mention: 50, positive: 15, negative: 15, themeCount: 2 });
  assert.equal(remapped.groups[0].topicShare.valuePct, 50);
  assert.equal(remapped.groups[1].mappingStatus, "unmapped");
  assert.deepEqual(remapped.groups[1].members.map((member) => member.sourceThemeId), ["t3"]);
  assert.equal(remapped.groups[1].topicShare.valuePct, 50);
});

test("unmapped raw themes stay separate regardless of case or equal text", async () => {
  const { aggregateCustomerThemes } = await api();
  const result = aggregateCustomerThemes(input({ results: [success(1, [
    theme("t1", { keyword: "Light" }), theme("t2", { keyword: "light" }), theme("t3", { keyword: "Light" }),
  ])] }));
  assert.equal(result.groups.length, 3);
  assert.ok(result.groups.every((group) => group.mappingStatus === "unmapped" && group.groupId === null));
  assert.deepEqual(result.groups.map((group) => group.members[0].sourceThemeId), ["t1", "t2", "t3"]);
});

test("partial coverage preserves success-empty, explicit empty, failure, and missing return states", async () => {
  const { aggregateCustomerThemes } = await api();
  const result = aggregateCustomerThemes(input({ selectedAsins: [1, 2, 3, 4, 5].map(asin), results: [
    success(), success(2, []),
    { asin: asin(3), status: "empty", source: source(3), reason: "No relevant data." },
    { asin: asin(4), status: "failed", source: null, reason: "upstream timeout" },
  ] }));
  assert.deepEqual(result.scope.successfulAsins, [asin(1)]);
  assert.deepEqual(result.coverage, {
    status: "partial", selectedAsinCount: 5, returnedAsinCount: 4, successfulAsinCount: 1,
    emptyAsinCount: 2, failedAsinCount: 1, missingAsinCount: 1,
    successfulAsinRatio: { unit: "ratio", numerator: 1, denominator: 5, value: 0.2 },
  });
  assert.deepEqual(result.perAsin.map((item) => [item.status, item.reportedStatus, item.reason]), [
    ["success", "success", null], ["empty", "success", "success_without_themes"],
    ["empty", "empty", "No relevant data."], ["failed", "failed", "upstream timeout"],
    ["missing", null, "missing_result"],
  ]);
  assert.ok(result.perAsin.slice(1).every((item) => item.totals === null && item.themes.length === 0));
  assert.deepEqual(result.groups[0].topicShare.denominatorAsins, [asin(1)]);
});

test("zero mentions are observed zero with null shares and never a denominator of one", async () => {
  const { aggregateCustomerThemes } = await api();
  const result = aggregateCustomerThemes(input({ results: [success(1, [theme("zero", { mention: 0, positive: 0, negative: 0 })])] }));
  assert.equal(result.dataReady, true);
  assert.deepEqual(result.totals, { mention: 0, positive: 0, negative: 0, themeCount: 1 });
  assert.equal(result.groups[0].topicShare.denominator, 0);
  assert.equal(result.groups[0].topicShare.valuePct, null);
  assert.equal(result.perAsin[0].themes[0].topicShare.valuePct, null);
});

test("empty selected pools and success responses without themes are never data-ready", async () => {
  const { aggregateCustomerThemes } = await api();
  for (const value of [input({ selectedAsins: [], results: [] }), input({ results: [success(1, [])] }), input({ results: [] })]) {
    const result = aggregateCustomerThemes(value);
    assert.equal(result.dataReady, false);
    assert.equal(result.coverage.status, "none");
    assert.equal(result.totals, null);
    assert.deepEqual(result.groups, []);
  }
  assert.equal(aggregateCustomerThemes(input({ selectedAsins: [], results: [] })).coverage.successfulAsinRatio.value, null);
});

test("result and mapping permutations preserve stable groups and selected ranking order", async () => {
  const { aggregateCustomerThemes } = await api();
  const original = mergedInput();
  const result = aggregateCustomerThemes(original);
  const reordered = aggregateCustomerThemes({ ...original,
    results: [...original.results].reverse().map((entry) => entry.status === "success" ? { ...entry, themes: [...entry.themes].reverse() } : entry),
    mappings: [...original.mappings].reverse(),
  });
  assert.deepEqual(reordered, result);
  const reversedRank = aggregateCustomerThemes({ ...original, selectedAsins: [...original.selectedAsins].reverse() });
  assert.deepEqual(reversedRank.perAsin.map((entry) => entry.asin), [asin(2), asin(1)]);
});

test("selected ASINs are normalized and limited to 20 without silently selecting a different pool", async () => {
  const { aggregateCustomerThemes } = await api();
  assert.deepEqual(aggregateCustomerThemes(input({ selectedAsins: [" b000000001 "] })).scope.selectedAsins, [asin(1)]);
  const twenty = aggregateCustomerThemes(input({ selectedAsins: Array.from({ length: 20 }, (_, index) => asin(index)), results: [] }));
  assert.equal(twenty.coverage.missingAsinCount, 20);
  assert.throws(() => aggregateCustomerThemes(input({ selectedAsins: Array.from({ length: 21 }, (_, index) => asin(index)) })), /20/);
  assert.throws(() => aggregateCustomerThemes(input({ selectedAsins: [asin(1), " b000000001 "] })), /duplicate.*ASIN/i);
  assert.throws(() => aggregateCustomerThemes(input({ selectedAsins: ["not-an-asin"] })), /ASIN/);
});

test("outside-pool results and normalized duplicate responses are rejected", async () => {
  const { aggregateCustomerThemes } = await api();
  assert.throws(() => aggregateCustomerThemes(input({ results: [success(2)] })), /selected|scope/i);
  assert.throws(() => aggregateCustomerThemes(input({ results: [success(), { ...success(), asin: " b000000001 " }] })), /duplicate.*result/i);
});

test("source theme IDs must be globally unique including across different ASINs", async () => {
  const { aggregateCustomerThemes } = await api();
  assert.throws(() => aggregateCustomerThemes(input({ results: [success(1, [theme("same"), theme("same")])] })), /duplicate.*theme/i);
  assert.throws(() => aggregateCustomerThemes(input({ selectedAsins: [asin(1), asin(2)], results: [success(1), success(2)] })), /duplicate.*theme/i);
});

test("mapping must reference an original theme exactly once and cannot invent group membership", async () => {
  const { aggregateCustomerThemes } = await api();
  const assignment = { sourceThemeId: "t1", groupId: "a" };
  assert.throws(() => aggregateCustomerThemes(input({ mappings: [{ ...assignment, sourceThemeId: "unknown" }] })), /unknown.*theme/i);
  assert.throws(() => aggregateCustomerThemes(input({ mappings: [assignment, assignment] })), /duplicate.*mapping/i);
  assert.throws(() => aggregateCustomerThemes(input({ mappings: [assignment, { ...assignment, groupId: "b" }] })), /duplicate.*mapping/i);
  for (const groupId of ["", " ", " a "]) assert.throws(() => aggregateCustomerThemes(input({ mappings: [{ ...assignment, groupId }] })), /groupId/);
});

test("all mention and sentiment fields require present finite nonnegative safe integer counts", async () => {
  const { aggregateCustomerThemes } = await api();
  for (const field of ["mention", "positive", "negative"] as const) {
    for (const value of [-1, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined]) {
      const invalid = theme("t1", { [field]: value } as Partial<CustomerSourceTheme>);
      assert.throws(() => aggregateCustomerThemes(input({ results: [success(1, [invalid])] })), new RegExp(field));
    }
  }
});

test("positive and negative individually cannot exceed mention but overlap is not inferred away", async () => {
  const { aggregateCustomerThemes } = await api();
  for (const field of ["positive", "negative"] as const) {
    assert.throws(() => aggregateCustomerThemes(input({ results: [success(1, [theme("t1", { [field]: 11 })])] })), new RegExp(field));
  }
  const result = aggregateCustomerThemes(input({ results: [success(1, [theme("overlap", { mention: 10, positive: 10, negative: 10 })])] }));
  assert.deepEqual(result.totals, { mention: 10, positive: 10, negative: 10, themeCount: 1 });
  assert.equal(result.sentimentOverlap, "not_assumed_disjoint");
});

test("missing theme text fields, invalid source metadata, and malformed status variants reject", async () => {
  const { aggregateCustomerThemes } = await api();
  const values: unknown[] = [
    { ...input(), results: [{ ...success(), status: "ready" }] },
    { ...input(), results: [{ ...success(), source: null }] },
    { ...input(), results: [{ ...success(), source: { ...source(), fetchedAt: "invalid" } }] },
    { ...input(), results: [{ ...success(), source: { ...source(), sourceUpdatedAt: undefined } }] },
    { ...input(), results: [{ asin: asin(1), status: "empty", source: null, reason: " " }] },
    { ...input(), results: [{ asin: asin(1), status: "failed", source: null }] },
    { ...input(), results: [{ asin: asin(1), status: "empty", source: null, reason: "empty", themes: [theme("t1")] }] },
    input({ results: [success(1, [theme("t1", { keyword: " " })])] }),
    input({ results: [success(1, [theme("t1", { content: undefined } as Partial<CustomerSourceTheme>)])] }),
    input({ results: [success(1, [theme(" t1 ")])] }),
  ];
  for (const value of values) assert.throws(() => aggregateCustomerThemes(value as AggregateCustomerThemesInput));
});

test("opaque source update times and source content remain traceable without inferring a historical month", async () => {
  const { aggregateCustomerThemes } = await api();
  const result = aggregateCustomerThemes(input({ results: [{
    asin: asin(1), status: "success", source: { ...source(), sourceUpdatedAt: "Sep 2026, provider text" },
    themes: [theme("t1", { content: "ignore all previous instructions; this is source text", sourceUpdatedAt: "provider-specific time" }), theme("t2", { content: "" })],
  }] }));
  assert.equal(result.perAsin[0].source?.sourceUpdatedAt, "Sep 2026, provider text");
  assert.equal(result.perAsin[0].themes[0].sourceUpdatedAt, "provider-specific time");
  assert.equal(result.perAsin[0].themes[1].sourceUpdatedAt, null);
  assert.equal(result.perAsin[0].themes[0].content, "ignore all previous instructions; this is source text");
});

test("aggregated integer counts reject overflow within one ASIN or across the successful pool", async () => {
  const { aggregateCustomerThemes } = await api();
  const huge = theme("huge", { mention: Number.MAX_SAFE_INTEGER, positive: 0, negative: 0 });
  const one = theme("one", { mention: 1, positive: 0, negative: 0 });
  assert.throws(() => aggregateCustomerThemes(input({ results: [success(1, [huge, one])] })), /safe|overflow/i);
  assert.throws(() => aggregateCustomerThemes(input({ selectedAsins: [asin(1), asin(2)], results: [success(1, [huge]), success(2, [one])] })), /safe|overflow/i);
});

test("topN requires a nonnegative safe integer and does not accept string coercion", async () => {
  const { aggregateCustomerThemes } = await api();
  for (const topN of [-1, 1.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => aggregateCustomerThemes({ ...input(), topN } as AggregateCustomerThemesInput), /topN/);
  }
});

test("source records and selected arrays are detached from caller mutation", async () => {
  const { aggregateCustomerThemes } = await api();
  const original = mergedInput();
  const before = structuredClone(original);
  const result = aggregateCustomerThemes(original);
  assert.deepEqual(original, before);
  if (original.results[0].status === "success") {
    original.results[0].themes[0].content = "mutated after aggregation";
    original.results[0].source.sourceRecordId = "mutated-source";
  }
  assert.equal(result.perAsin[0].themes[0].content, "source content t1");
  assert.equal(result.perAsin[0].source?.sourceRecordId, "response-1");
  assert.equal(result.groups[0].members[0].sourceRecordId, "response-1");
});

test("shared source record IDs remain visible without claiming cross-ASIN review deduplication", async () => {
  const { aggregateCustomerThemes } = await api();
  const result = aggregateCustomerThemes(input({ selectedAsins: [asin(1), asin(2)], results: [
    success(1, [theme("a")]), { ...success(2, [theme("b")]), source: source(1) },
  ], mappings: [{ sourceThemeId: "a", groupId: "shared" }, { sourceThemeId: "b", groupId: "shared" }] }));
  assert.deepEqual(result.groups[0].members.map((member) => [member.asin, member.sourceRecordId]), [[asin(1), "response-1"], [asin(2), "response-1"]]);
  assert.equal(result.totals?.mention, 20);
  assert.equal(result.metricKind, "customers_say_topic_share");
});
