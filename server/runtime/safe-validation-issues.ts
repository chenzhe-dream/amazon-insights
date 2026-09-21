import { isMarketSemanticValidationRuleId } from '../domain/market-research/semantic-validation-rules';
import type { z } from "zod";

import { isVocPositioningValidationRuleId } from "../domain/voc/voc-positioning-contracts";
import type { StructuredResponseFormat } from "./structured-response-format";

export interface SafeValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly expected?: string;
  readonly ruleId?: string;
}

const MAX_ISSUES = 10;
const MAX_PATH_SEGMENTS = 16;
const MAX_REPAIR_GUIDANCE_LINES = 8;
const MAX_REPAIR_GUIDANCE_CHARS = 24_000;
const FORBIDDEN_REPAIR_GUIDANCE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_PATH_PROPERTY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE_VALUES = new Set([
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "not_multiple_of",
  "unrecognized_keys",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  "invalid_value",
  "custom",
]);
const SAFE_EXPECTED_VALUES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "undefined",
  "null",
  "object",
  "array",
  "function",
  "date",
  "nan",
  "never",
  "void",
  "int",
]);

export function summarizeZodValidationIssues(
  error: z.ZodError,
  responseFormat: StructuredResponseFormat,
): readonly SafeValidationIssue[] {
  const declaredProperties = declaredPropertyNames(responseFormat.format.schema);
  return Object.freeze(
    error.issues.slice(0, MAX_ISSUES).map((issue) => {
      const path = Object.freeze(
        issue.path.slice(0, MAX_PATH_SEGMENTS).map((segment) => {
          if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
            return segment;
          }
          return typeof segment === "string" &&
            SAFE_PATH_PROPERTY.test(segment) &&
            declaredProperties.has(segment)
            ? segment
            : "<field>";
        }),
      );
      const expected = safeExpected(issue);
      const ruleId = safeRuleId(issue);
      return Object.freeze({
        path,
        code:
          typeof issue.code === "string" && SAFE_CODE_VALUES.has(issue.code)
            ? issue.code
            : "validation",
        ...(expected ? { expected } : {}),
        ...(ruleId ? { ruleId } : {}),
      });
    }),
  );
}

export function freezeSafeValidationIssues(
  issues: readonly SafeValidationIssue[],
  declaredJsonSchema: Readonly<Record<string, unknown>>,
): readonly SafeValidationIssue[] {
  const declaredProperties = declaredPropertyNames(declaredJsonSchema);
  return Object.freeze(
    issues.slice(0, MAX_ISSUES).map((issue) => {
      const path = Array.isArray(issue.path)
        ? issue.path.slice(0, MAX_PATH_SEGMENTS).map((segment) =>
            typeof segment === "number" &&
            Number.isSafeInteger(segment) &&
            segment >= 0
              ? segment
              : typeof segment === "string" &&
                    SAFE_PATH_PROPERTY.test(segment) &&
                    declaredProperties.has(segment)
                ? segment
                : "<field>",
          )
        : [];
      const expected =
        typeof issue.expected === "string" && SAFE_EXPECTED_VALUES.has(issue.expected)
          ? issue.expected
          : undefined;
      const ruleId = safeRuleId(issue);
      return Object.freeze({
        path: Object.freeze(path),
        code:
          typeof issue.code === "string" && SAFE_CODE_VALUES.has(issue.code)
            ? issue.code
            : "validation",
        ...(expected ? { expected } : {}),
        ...(ruleId ? { ruleId } : {}),
      });
    }),
  );
}

export function createFormatRepairInstruction(
  instructions: string,
  issues: readonly SafeValidationIssue[],
  guidance?: unknown,
): string {
  const repair = "FORMAT REPAIR: The previous response failed the declared schema. Regenerate the answer from the original input and exactly match the schema. Do not add fields.";
  const generic = issues.length === 0
    ? `${instructions}\n\n${repair}`
    : `${instructions}\n\n${repair} Correct these safe schema diagnostics: ${JSON.stringify(issues)}`;
  const normalizedGuidance = normalizeFormatRepairGuidance(guidance);
  return normalizedGuidance
    ? `${generic}\nContract-specific repair guidance (closed and bounded):\n${normalizedGuidance.join("\n")}`
    : generic;
}

export function normalizeFormatRepairGuidance(
  value: unknown,
): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REPAIR_GUIDANCE_LINES) {
    return null;
  }
  const lines: string[] = [];
  let totalChars = 0;
  for (const item of value) {
    if (typeof item !== "string") return null;
    const line = item.trim();
    if (!line || FORBIDDEN_REPAIR_GUIDANCE_CONTROL.test(line)) return null;
    totalChars += line.length;
    if (line.length > MAX_REPAIR_GUIDANCE_CHARS || totalChars > MAX_REPAIR_GUIDANCE_CHARS) {
      return null;
    }
    lines.push(line);
  }
  return Object.freeze(lines);
}

function safeExpected(issue: z.core.$ZodIssue): string | undefined {
  const expected = (issue as { expected?: unknown }).expected;
  return typeof expected === "string" && SAFE_EXPECTED_VALUES.has(expected)
    ? expected
    : undefined;
}

function safeRuleId(issue: unknown): string | undefined {
  const ruleId = issue !== null && typeof issue === "object"
    ? (issue as { params?: { ruleId?: unknown }; ruleId?: unknown }).params?.ruleId ??
      (issue as { ruleId?: unknown }).ruleId
    : undefined;
  return isVocPositioningValidationRuleId(ruleId) || isMarketSemanticValidationRuleId(ruleId) ? ruleId : undefined;
}

function declaredPropertyNames(schema: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const names = new Set<string>();
  const visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const properties = record.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [name, child] of Object.entries(properties)) {
        names.add(name);
        visit(child);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(schema);
  return names;
}
