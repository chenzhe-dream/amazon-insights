import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";

import { canonicalJsonSha256 } from "./model-request-accounting";

export interface StrictJsonSchemaResponseFormat {
  readonly type: "json_schema";
  readonly name: string;
  readonly strict: true;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface StructuredResponseFormat {
  readonly format: StrictJsonSchemaResponseFormat;
  readonly digest: string;
}

export function createStructuredResponseFormat<T>(
  schema: z.ZodType<T>,
  contractName: string,
): StructuredResponseFormat {
  const generated = zodTextFormat(schema, formatName(contractName));
  if (
    generated.type !== "json_schema" ||
    generated.strict !== true ||
    typeof generated.name !== "string" ||
    !generated.schema ||
    typeof generated.schema !== "object" ||
    Array.isArray(generated.schema)
  ) {
    throw new TypeError("Invalid strict structured response format");
  }
  const format = deepFreeze({
    type: "json_schema" as const,
    name: generated.name,
    strict: true as const,
    schema: generated.schema,
  });
  const digest = canonicalJsonSha256(format);
  return Object.freeze({ format, digest });
}

function formatName(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return normalized || "structured_output";
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
