import type { z } from "zod";

import type { StructuredResponseFormat } from "./structured-response-format";

export interface SafeValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly expected?: string;
}

const MAX_ISSUES = 10;
const MAX_PATH_SEGMENTS = 16;
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
      return Object.freeze({
        path,
        code:
          typeof issue.code === "string" && SAFE_CODE_VALUES.has(issue.code)
            ? issue.code
            : "validation",
        ...(expected ? { expected } : {}),
      });
    }),
  );
}

export function freezeSafeValidationIssues(
  issues: readonly SafeValidationIssue[],
): readonly SafeValidationIssue[] {
  return Object.freeze(
    issues.slice(0, MAX_ISSUES).map((issue) => {
      const path = Array.isArray(issue.path)
        ? issue.path.slice(0, MAX_PATH_SEGMENTS).map((segment) =>
            typeof segment === "number" &&
            Number.isSafeInteger(segment) &&
            segment >= 0
              ? segment
              : "<field>",
          )
        : [];
      const expected =
        typeof issue.expected === "string" && SAFE_EXPECTED_VALUES.has(issue.expected)
          ? issue.expected
          : undefined;
      return Object.freeze({
        path: Object.freeze(path),
        code:
          typeof issue.code === "string" && SAFE_CODE_VALUES.has(issue.code)
            ? issue.code
            : "validation",
        ...(expected ? { expected } : {}),
      });
    }),
  );
}

export function createFormatRepairInstruction(
  instructions: string,
  issues: readonly SafeValidationIssue[],
): string {
  const repair = "FORMAT REPAIR: The previous response failed the declared schema. Regenerate the answer from the original input and exactly match the schema. Do not add fields.";
  return issues.length === 0
    ? `${instructions}\n\n${repair}`
    : `${instructions}\n\n${repair} Correct these safe schema diagnostics: ${JSON.stringify(issues)}`;
}

function safeExpected(issue: z.core.$ZodIssue): string | undefined {
  const expected = (issue as { expected?: unknown }).expected;
  return typeof expected === "string" && SAFE_EXPECTED_VALUES.has(expected)
    ? expected
    : undefined;
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
