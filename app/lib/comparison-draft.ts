export const MIN_COMPARISON_ASINS = 3;
export const MAX_COMPARISON_ASINS = 10;

export type DraftIssue =
  | Readonly<{ code: "invalid"; slot: number; value: string }>
  | Readonly<{ code: "duplicate"; slot: number; value: string }>
  | Readonly<{ code: "too-few"; attemptedCount: number }>
  | Readonly<{ code: "too-many"; attemptedCount: number }>;

export type ComparisonDraft = Readonly<{
  slots: readonly string[];
  normalizedAsins: readonly string[];
  issues: readonly DraftIssue[];
  source: "empty" | "url" | "project" | "run" | "user";
  basedOnProjectId: string | null;
  dirty: boolean;
  revision: number;
}>;

export type CommittedComparisonScope = Readonly<{
  organizationId: string;
  marketplace: "US";
  projectId: string;
  runId: string | null;
  asins: readonly string[];
  committedAt: string;
}>;

export type ValidComparisonDraftSnapshot = Readonly<{
  marketplace: "US";
  asins: readonly string[];
  draftRevision: number;
}>;

export type ComparisonDraftAction =
  | Readonly<{ type: "add"; value: string }>
  | Readonly<{ type: "remove"; index: number }>
  | Readonly<{ type: "replace"; index: number; value: string }>
  | Readonly<{ type: "clear" }>;

type DraftSeed = Readonly<{
  slots?: readonly string[];
  source?: ComparisonDraft["source"];
  basedOnProjectId?: string | null;
  dirty?: boolean;
  revision?: number;
}>;

type SlotAnalysis = Readonly<{
  slots: readonly string[];
  normalizedAsins: readonly string[];
  issues: readonly DraftIssue[];
}>;

function freezeIssue(issue: DraftIssue): DraftIssue {
  return Object.freeze(issue);
}

function freezeIssues(issues: readonly DraftIssue[]): readonly DraftIssue[] {
  return Object.freeze(issues.map(freezeIssue));
}

function analyzeSlots(values: readonly string[]): SlotAnalysis {
  const slots = values.map(value => value.trim().toUpperCase()).filter(Boolean);
  const normalizedAsins: string[] = [];
  const issues: DraftIssue[] = [];
  const seen = new Set<string>();

  slots.forEach((value, slot) => {
    if (!/^[A-Z0-9]{10}$/.test(value)) {
      issues.push({ code: "invalid", slot, value });
      return;
    }
    if (seen.has(value)) {
      issues.push({ code: "duplicate", slot, value });
      return;
    }
    seen.add(value);
    normalizedAsins.push(value);
  });

  return Object.freeze({
    slots: Object.freeze(slots),
    normalizedAsins: Object.freeze(normalizedAsins),
    issues: freezeIssues(issues),
  });
}

function freezeDraft(
  analysis: SlotAnalysis,
  metadata: Pick<ComparisonDraft, "source" | "basedOnProjectId" | "dirty" | "revision">,
): ComparisonDraft {
  return Object.freeze({
    slots: analysis.slots,
    normalizedAsins: analysis.normalizedAsins,
    issues: analysis.issues,
    ...metadata,
  });
}

export function createComparisonDraft(seed: DraftSeed = {}): ComparisonDraft {
  const analysis = analyzeSlots(seed.slots ?? []);
  if (analysis.slots.length > MAX_COMPARISON_ASINS) {
    return freezeDraft(
      {
        slots: Object.freeze([]),
        normalizedAsins: Object.freeze([]),
        issues: freezeIssues([{ code: "too-many", attemptedCount: analysis.slots.length }]),
      },
      {
        source: seed.source ?? "empty",
        basedOnProjectId: seed.basedOnProjectId ?? null,
        dirty: seed.dirty ?? false,
        revision: seed.revision ?? 0,
      },
    );
  }
  return freezeDraft(analysis, {
    source: seed.source ?? (analysis.slots.length === 0 ? "empty" : "user"),
    basedOnProjectId: seed.basedOnProjectId ?? null,
    dirty: seed.dirty ?? false,
    revision: seed.revision ?? 0,
  });
}

export function reduceComparisonDraft(
  draft: ComparisonDraft,
  action: ComparisonDraftAction,
): ComparisonDraft {
  let slots: string[];
  switch (action.type) {
    case "add":
      slots = [...draft.slots, action.value];
      break;
    case "remove":
      if (action.index < 0 || action.index >= draft.slots.length) return draft;
      slots = draft.slots.filter((_, index) => index !== action.index);
      break;
    case "replace":
      if (action.index < 0 || action.index >= draft.slots.length) return draft;
      slots = draft.slots.map((value, index) => (index === action.index ? action.value : value));
      break;
    case "clear":
      slots = [];
      break;
  }

  const analysis = analyzeSlots(slots);
  if (analysis.slots.length > MAX_COMPARISON_ASINS) {
    const issues = freezeIssues([
      ...draft.issues.filter(issue => issue.code !== "too-many"),
      { code: "too-many", attemptedCount: analysis.slots.length },
    ]);
    return Object.freeze({ ...draft, issues });
  }

  return freezeDraft(analysis, {
    source: "user",
    basedOnProjectId: draft.basedOnProjectId,
    dirty: true,
    revision: draft.revision + 1,
  });
}

export type ComparisonDraftValidation =
  | Readonly<{ ok: true; snapshot: ValidComparisonDraftSnapshot }>
  | Readonly<{ ok: false; issues: readonly DraftIssue[] }>;

export function validateComparisonDraft(draft: ComparisonDraft): ComparisonDraftValidation {
  const issues = [...draft.issues];
  if (draft.normalizedAsins.length < MIN_COMPARISON_ASINS) {
    issues.push({ code: "too-few", attemptedCount: draft.normalizedAsins.length });
  } else if (draft.normalizedAsins.length > MAX_COMPARISON_ASINS) {
    issues.push({ code: "too-many", attemptedCount: draft.normalizedAsins.length });
  }

  if (issues.length > 0) {
    return Object.freeze({ ok: false, issues: freezeIssues(issues) });
  }

  return Object.freeze({
    ok: true,
    snapshot: Object.freeze({
      marketplace: "US" as const,
      asins: Object.freeze([...draft.normalizedAsins]),
      draftRevision: draft.revision,
    }),
  });
}

export function parseComparisonAsinAttempt(
  raw: string,
  max = MAX_COMPARISON_ASINS,
): Readonly<{
  asins: readonly string[];
  invalid: readonly string[];
  duplicates: readonly string[];
  rejected: readonly string[];
}> {
  const tokens = raw
    .split(/[\s,，、;；|]+/)
    .map(value => value.trim())
    .filter(Boolean);
  const analysis = analyzeSlots(tokens);
  const invalid = analysis.issues
    .filter((issue): issue is Extract<DraftIssue, { code: "invalid" }> => issue.code === "invalid")
    .map(issue => issue.value);
  const duplicates = [
    ...new Set(
      analysis.issues
        .filter((issue): issue is Extract<DraftIssue, { code: "duplicate" }> => issue.code === "duplicate")
        .map(issue => issue.value),
    ),
  ];
  const overLimit = analysis.normalizedAsins.length > max;

  return Object.freeze({
    asins: overLimit ? Object.freeze([]) : analysis.normalizedAsins,
    invalid: Object.freeze(invalid),
    duplicates: Object.freeze(duplicates),
    rejected: overLimit ? analysis.normalizedAsins : Object.freeze([]),
  });
}
