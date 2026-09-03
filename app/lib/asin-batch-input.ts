import { parseComparisonAsinAttempt } from "./comparison-draft";

export type BatchAsinParseResult = {
  asins: string[];
  invalid: string[];
  duplicates: string[];
  overflow: string[];
  canSubmit: boolean;
};

export function parseBatchAsinInput(raw: string, max = 10): BatchAsinParseResult {
  const attempt = parseComparisonAsinAttempt(raw, max);
  const asins = [...attempt.asins];
  const invalid = [...attempt.invalid];
  const duplicates = [...attempt.duplicates];
  const overflow = [...attempt.rejected];
  return {
    asins,
    invalid,
    duplicates,
    overflow,
    canSubmit:
      asins.length >= 3 &&
      asins.length <= max &&
      invalid.length === 0 &&
      duplicates.length === 0 &&
      overflow.length === 0,
  };
}
