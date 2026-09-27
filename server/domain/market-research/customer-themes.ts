import {ThemeQuarantineSchema,type ThemeQuarantine} from '../../../shared/market-theme-quality';
import { z } from "zod";

export type CustomerThemeSource = {
  sourceRecordId: string;
  fetchedAt: string;
  /** Opaque upstream update text, never an inferred research month. */
  sourceUpdatedAt: string | null;
};

export type CustomerSourceTheme = {
  sourceThemeId: string;
  keyword: string;
  content: string;
  mention: number;
  positive: number;
  negative: number;
  sourceUpdatedAt?: string | null;
};

export type CustomerThemesAsinInput =
  | { asin: string; status: "success"; source: CustomerThemeSource; themes: readonly CustomerSourceTheme[]; quarantine?:ThemeQuarantine }
  | { asin: string; status: "empty" | "failed"; source: CustomerThemeSource | null; reason: string };

export type CustomerThemeMapping = { sourceThemeId: string; groupId: string };

export type AggregateCustomerThemesInput = {
  /** Fixed upstream-selected pool, at most 20; order retains the caller's ranking. */
  selectedAsins: readonly string[];
  results: readonly CustomerThemesAsinInput[];
  mappings: readonly CustomerThemeMapping[];
  /** Display rows only; omitted means all groups and zero deliberately displays none. */
  topN?: number;
};

export type CustomerThemeCounts = { mention: number; positive: number; negative: number; themeCount: number };

export type CustomerTopicShare = {
  metricKind: "customers_say_topic_share";
  numerator: number;
  denominator: number;
  /** Unrounded 0–100 percent; zero denominator means null. */
  valuePct: number | null;
  denominatorAsins: string[];
};

export type CustomerThemeEvidence = Omit<CustomerSourceTheme, "sourceUpdatedAt"> & {
  asin: string;
  sourceRecordId: string;
  sourceUpdatedAt: string | null;
};

export type CustomerThemesAsinSummary = {
  asin: string;
  status: "success" | "empty" | "failed" | "missing";
  quarantine?:ThemeQuarantine;
  reportedStatus: "success" | "empty" | "failed" | null;
  reason: string | null;
  source: CustomerThemeSource | null;
  totals: CustomerThemeCounts | null;
  /** Complete raw evidence and each ASIN's own denominator, unaffected by topN. */
  themes: (CustomerThemeEvidence & { topicShare: CustomerTopicShare })[];
};

export type CustomerThemeGroup = {
  mappingStatus: "mapped" | "unmapped";
  groupId: string | null;
  /** Source observations; not unique reviews or independent buyer samples. */
  members: CustomerThemeEvidence[];
  totals: CustomerThemeCounts;
  topicShare: CustomerTopicShare;
};

export type CustomerThemeAggregation = {
  metricKind: "customers_say_topic_share";
  sentimentOverlap: "not_assumed_disjoint";
  /** At least one nonempty valid success response; does not imply full coverage or semantic readiness. */
  dataReady: boolean;
  scope: { selectedAsins: string[]; successfulAsins: string[] };
  coverage: {
    status: "complete" | "partial" | "none";
    selectedAsinCount: number;
    returnedAsinCount: number;
    successfulAsinCount: number;
    quarantinedThemeCount?:number;
    emptyAsinCount: number;
    failedAsinCount: number;
    missingAsinCount: number;
    successfulAsinRatio: { unit: "ratio"; numerator: number; denominator: number; value: number | null };
  };
  /** Null means no valid source themes; zero mentions in actual themes remain known zero. */
  totals: CustomerThemeCounts | null;
  perAsin: CustomerThemesAsinSummary[];
  /** Complete explicit assignments supplied by the caller, including hidden groups. */
  mappings: CustomerThemeMapping[];
  groups: CustomerThemeGroup[];
  display: { topN: number | null; totalGroupCount: number; displayedGroupCount: number; omittedGroupCount: number };
};

const identity = z.string().min(1).refine((value) => value.trim() === value, "Identity cannot have surrounding whitespace");
const asinSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, "Invalid ASIN");
const nonemptyText = z.string().refine((value) => value.trim().length > 0, "Text must not be empty");
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sourceSchema = z.object({
  sourceRecordId: identity,
  fetchedAt: z.string().datetime({ offset: true }),
  sourceUpdatedAt: nonemptyText.nullable(),
}).strict();
const themeSchema = z.object({
  sourceThemeId: identity,
  keyword: nonemptyText,
  content: z.string(),
  mention: count,
  positive: count,
  negative: count,
  sourceUpdatedAt: nonemptyText.nullable().optional(),
}).strict().superRefine((theme, context) => {
  for (const field of ["positive", "negative"] as const) {
    if (theme[field] > theme.mention) {
      context.addIssue({ code: "custom", path: [field], message: `${field} cannot exceed mention` });
    }
  }
});
const resultSchema = z.discriminatedUnion("status", [
  z.object({ asin: asinSchema, status: z.literal("success"), source: sourceSchema, themes: z.array(themeSchema), quarantine:ThemeQuarantineSchema.optional() }).strict(),
  z.object({ asin: asinSchema, status: z.literal("empty"), source: sourceSchema.nullable(), reason: nonemptyText }).strict(),
  z.object({ asin: asinSchema, status: z.literal("failed"), source: sourceSchema.nullable(), reason: nonemptyText }).strict(),
]);
const inputSchema = z.object({
  selectedAsins: z.array(asinSchema).max(20),
  results: z.array(resultSchema),
  mappings: z.array(z.object({ sourceThemeId: identity, groupId: identity }).strict()),
  topN: count.optional(),
}).strict();

const compareIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function addCount(current: number, value: number): number {
  if (value > Number.MAX_SAFE_INTEGER - current) throw new RangeError("Aggregated count exceeds the safe integer range (overflow)");
  return current + value;
}

function summarize(themes: readonly CustomerThemeEvidence[]): CustomerThemeCounts {
  const totals = { mention: 0, positive: 0, negative: 0, themeCount: themes.length };
  for (const theme of themes) {
    totals.mention = addCount(totals.mention, theme.mention);
    totals.positive = addCount(totals.positive, theme.positive);
    totals.negative = addCount(totals.negative, theme.negative);
  }
  return totals;
}

function topicShare(numerator: number, denominator: number, asins: readonly string[]): CustomerTopicShare {
  return {
    metricKind: "customers_say_topic_share", numerator, denominator,
    valuePct: denominator === 0 ? null : numerator / denominator * 100,
    denominatorAsins: [...asins],
  };
}

/**
 * Aggregate source theme mentions from a fixed selected pool and explicit mappings.
 * This never deduplicates reviews, infers sentiment exclusivity, or classifies text.
 * The caller verifies pool ranking, source compatibility, and collection-time scope.
 */
export function aggregateCustomerThemes(input: AggregateCustomerThemesInput): CustomerThemeAggregation {
  const parsed = inputSchema.parse(input);
  const selected = new Set(parsed.selectedAsins);
  if (selected.size !== parsed.selectedAsins.length) throw new TypeError("Duplicate selected ASIN");
  const results = new Map<string, (typeof parsed.results)[number]>();
  for (const result of parsed.results) {
    if (!selected.has(result.asin)) throw new TypeError(`ASIN result is outside the selected scope: ${result.asin}`);
    if (results.has(result.asin)) throw new TypeError(`Duplicate ASIN result: ${result.asin}`);
    results.set(result.asin, result);
  }

  const successfulAsins: string[] = [];
  const perAsin: CustomerThemesAsinSummary[] = [];
  const allThemes: CustomerThemeEvidence[] = [];
  const themeIds = new Set<string>();
  for (const asin of parsed.selectedAsins) {
    const result = results.get(asin);
    if (!result) {
      perAsin.push({ asin, status: "missing", reportedStatus: null, reason: "missing_result", source: null, totals: null, themes: [] });
      continue;
    }
    if (result.status !== "success") {
      perAsin.push({ asin, status: result.status, reportedStatus: result.status, reason: result.reason, source: result.source, totals: null, themes: [] });
      continue;
    }
    if (result.themes.length === 0) {
      perAsin.push({ asin, status: "empty", reportedStatus: "success", reason: "success_without_themes", source: result.source, totals: null, themes: [] });
      continue;
    }
    if(result.quarantine && result.themes.length+result.quarantine.rejected.length!==result.quarantine.receivedCount)throw new TypeError('Theme quarantine coverage differs');
    const evidence = result.themes.map((theme): CustomerThemeEvidence => {
      if (themeIds.has(theme.sourceThemeId)) throw new TypeError(`Duplicate source theme ID: ${theme.sourceThemeId}`);
      themeIds.add(theme.sourceThemeId);
      return { ...theme, asin, sourceRecordId: result.source.sourceRecordId, sourceUpdatedAt: theme.sourceUpdatedAt ?? null };
    }).sort((left, right) => compareIds(left.sourceThemeId, right.sourceThemeId));
    const totals = summarize(evidence);
    successfulAsins.push(asin);
    allThemes.push(...evidence);
    perAsin.push({
      asin, status: "success", reportedStatus: "success", reason: null, source: result.source, totals,
      ...(result.quarantine?{quarantine:result.quarantine}:{}),
      themes: evidence.map((theme) => ({ ...theme, topicShare: topicShare(theme.mention, totals.mention, [asin]) })),
    });
  }
  allThemes.sort((left, right) => compareIds(left.sourceThemeId, right.sourceThemeId));
  const totals = allThemes.length === 0 ? null : summarize(allThemes);
  const assignments = new Map<string, string>();
  for (const mapping of parsed.mappings) {
    if (!themeIds.has(mapping.sourceThemeId)) throw new TypeError(`Unknown source theme in mapping: ${mapping.sourceThemeId}`);
    if (assignments.has(mapping.sourceThemeId)) throw new TypeError(`Duplicate theme mapping: ${mapping.sourceThemeId}`);
    assignments.set(mapping.sourceThemeId, mapping.groupId);
  }

  const mapped = new Map<string, CustomerThemeEvidence[]>();
  const rawGroups: { groupId: string | null; members: CustomerThemeEvidence[] }[] = [];
  for (const theme of allThemes) {
    const groupId = assignments.get(theme.sourceThemeId);
    if (groupId === undefined) rawGroups.push({ groupId: null, members: [theme] });
    else {
      const members = mapped.get(groupId) ?? [];
      members.push(theme);
      mapped.set(groupId, members);
    }
  }
  for (const [groupId, members] of mapped) rawGroups.push({ groupId, members });
  const groups = rawGroups.map(({ groupId, members }): CustomerThemeGroup => {
    const groupTotals = summarize(members);
    // A group exists only when at least one raw source theme was admitted.
    if (totals === null) throw new Error("Source theme totals are required for a group");
    return {
      mappingStatus: groupId === null ? "unmapped" : "mapped", groupId, members, totals: groupTotals,
      topicShare: topicShare(groupTotals.mention, totals.mention, successfulAsins),
    };
  }).sort((left, right) => right.totals.mention - left.totals.mention
    || compareIds(left.mappingStatus, right.mappingStatus)
    || compareIds(left.groupId ?? left.members[0].sourceThemeId, right.groupId ?? right.members[0].sourceThemeId));

  const displayedGroups = parsed.topN === undefined ? groups : groups.slice(0, parsed.topN);
  const selectedCount = parsed.selectedAsins.length;
  const successfulCount = successfulAsins.length;
  const quarantinedThemeCount=perAsin.reduce((n,a)=>n+(a.quarantine?.rejected.length??0),0);
  return {
    metricKind: "customers_say_topic_share", sentimentOverlap: "not_assumed_disjoint",
    dataReady: successfulCount > 0,
    scope: { selectedAsins: [...parsed.selectedAsins], successfulAsins },
    coverage: {
      status: successfulCount === 0 ? "none" : successfulCount === selectedCount && !quarantinedThemeCount ? "complete" : "partial",
      ...(quarantinedThemeCount?{quarantinedThemeCount}:{}),
      selectedAsinCount: selectedCount, returnedAsinCount: results.size, successfulAsinCount: successfulCount,
      emptyAsinCount: perAsin.filter((result) => result.status === "empty").length,
      failedAsinCount: perAsin.filter((result) => result.status === "failed").length,
      missingAsinCount: perAsin.filter((result) => result.status === "missing").length,
      successfulAsinRatio: { unit: "ratio", numerator: successfulCount, denominator: selectedCount, value: selectedCount === 0 ? null : successfulCount / selectedCount },
    },
    totals, perAsin,
    mappings: [...parsed.mappings].sort((left, right) => compareIds(left.sourceThemeId, right.sourceThemeId)),
    groups: displayedGroups,
    display: { topN: parsed.topN ?? null, totalGroupCount: groups.length, displayedGroupCount: displayedGroups.length, omittedGroupCount: groups.length - displayedGroups.length },
  };
}
