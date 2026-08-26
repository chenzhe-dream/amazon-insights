export type BatchAsinParseResult = {
  asins: string[];
  invalid: string[];
  duplicates: string[];
  overflow: string[];
  canSubmit: boolean;
};

export function parseBatchAsinInput(raw: string, max = 10): BatchAsinParseResult {
  const tokens = raw
    .toUpperCase()
    .split(/[\s,，、;；|]+/)
    .map(value => value.trim())
    .filter(Boolean);
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (!/^[A-Z0-9]{10}$/.test(token)) {
      invalid.push(token);
      continue;
    }
    if (seen.has(token)) {
      if (!duplicates.includes(token)) duplicates.push(token);
      continue;
    }
    seen.add(token);
    unique.push(token);
  }

  const asins = unique.slice(0, max);
  const overflow = unique.slice(max);
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
