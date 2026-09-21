import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import {
  freezeSafeValidationIssues,
  normalizeFormatRepairGuidance,
  summarizeZodValidationIssues,
} from "../../server/runtime/safe-validation-issues";
import { ModelProviderError } from "../../server/runtime/model-provider";
import { createStructuredResponseFormat } from "../../server/runtime/structured-response-format";

test("safe validation issues bound count and redact noncanonical path names", () => {
  const unsafeName = "unsafe/path";
  const longName = "a".repeat(65);
  const shape = Object.fromEntries(
    Array.from({ length: 11 }, (_, index) => [
      index === 0 ? unsafeName : index === 1 ? longName : `field${index}`,
      z.string(),
    ]),
  ) as Record<string, z.ZodString>;
  const schema = z.object(shape).strict();
  const value = Object.fromEntries(
    Object.keys(shape).map((key, index) => [key, index]),
  );
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false);
  if (parsed.success) return;

  const issues = summarizeZodValidationIssues(
    parsed.error,
    createStructuredResponseFormat(schema, "SafeIssueOutput@1.0.0"),
  );

  assert.equal(issues.length, 10);
  assert.deepEqual(issues[0], {
    path: ["<field>"],
    code: "invalid_type",
    expected: "string",
  });
  assert.deepEqual(issues[1], {
    path: ["<field>"],
    code: "invalid_type",
    expected: "string",
  });
  assert.equal(JSON.stringify(issues).includes(unsafeName), false);
  assert.equal(JSON.stringify(issues).includes(longName), false);
});

test("ModelProviderError freezes only bounded safe validation metadata", () => {
  const rawSentinel = "RAW_VOC_VALUE_SHOULD_NOT_ESCAPE";
  const error = new ModelProviderError("invalid_output", "safe", {
    validationIssues: [
      {
        path: ["safeField", `unsafe/${rawSentinel}`, -1, rawSentinel],
        code: "custom-provider-code",
        expected: rawSentinel,
      },
    ] as never,
  });

  assert.deepEqual(error.validationIssues, [
    {
      path: ["<field>", "<field>", "<field>", "<field>"],
      code: "validation",
    },
  ]);
  assert.equal(Object.isFrozen(error.validationIssues), true);
  assert.equal(
    JSON.stringify(error.validationIssues).includes(`unsafe/${rawSentinel}`),
    false,
  );
});

test("declared nested paths survive schema-aware double freezing", () => {
  const schema = z.strictObject({
    positioning: z.array(z.strictObject({ strategy: z.string() })),
  });
  const responseFormat = createStructuredResponseFormat(
    schema,
    "NestedSafeIssueOutput@1.0.0",
  );
  const parsed = schema.safeParse({ positioning: [{ strategy: "ok" }, {}, {}, {}, {}] });
  assert.equal(parsed.success, false);
  if (parsed.success) return;

  const issues = summarizeZodValidationIssues(parsed.error, responseFormat);
  assert.deepEqual(
    freezeSafeValidationIssues(issues, responseFormat.format.schema),
    [
      {
        path: ["positioning", 1, "strategy"],
        code: "invalid_type",
        expected: "string",
      },
      {
        path: ["positioning", 2, "strategy"],
        code: "invalid_type",
        expected: "string",
      },
      {
        path: ["positioning", 3, "strategy"],
        code: "invalid_type",
        expected: "string",
      },
      {
        path: ["positioning", 4, "strategy"],
        code: "invalid_type",
        expected: "string",
      },
    ],
  );
});

test("unknown path fields remain redacted after schema-aware double freezing", () => {
  const rawSentinel = "RAW_UNKNOWN_VALIDATION_FIELD";
  const responseFormat = createStructuredResponseFormat(
    z.strictObject({ positioning: z.array(z.strictObject({ strategy: z.string() })) }),
    "UnknownSafeIssueOutput@1.0.0",
  );
  const issues = freezeSafeValidationIssues([
    {
      path: ["positioning", 5, rawSentinel],
      code: "custom",
      expected: rawSentinel,
      ruleId: rawSentinel,
    } as never,
  ], responseFormat.format.schema);

  assert.deepEqual(issues, [
    {
      path: ["positioning", 5, "<field>"],
      code: "custom",
    },
  ]);
  assert.equal(JSON.stringify(issues).includes(rawSentinel), false);
});

test("registered custom rule IDs survive while custom messages do not", () => {
  const rawSentinel = "RAW_CUSTOM_MESSAGE_MUST_NOT_ESCAPE";
  const schema = z.strictObject({ identity: z.string() }).superRefine((_, context) => {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["identity"],
      message: rawSentinel,
      params: { ruleId: "voc-identity-mismatch" },
    });
  });
  const responseFormat = createStructuredResponseFormat(
    schema,
    "RuleIdSafeIssueOutput@1.0.0",
  );
  const parsed = schema.safeParse({ identity: "valid" });
  assert.equal(parsed.success, false);
  if (parsed.success) return;

  const issues = summarizeZodValidationIssues(parsed.error, responseFormat);
  assert.deepEqual(issues, [
    {
      path: ["identity"],
      code: "custom",
      ruleId: "voc-identity-mismatch",
    },
  ]);
  assert.equal(JSON.stringify(issues).includes(rawSentinel), false);
});

test("contract repair guidance accepts only bounded printable lines", () => {
  assert.deepEqual(normalizeFormatRepairGuidance(["closed guidance", "{\"safe\":true}"]), [
    "closed guidance",
    "{\"safe\":true}",
  ]);
  assert.equal(normalizeFormatRepairGuidance(["unsafe\u0000control"]), null);
  assert.equal(normalizeFormatRepairGuidance(["x".repeat(24_001)]), null);
  assert.equal(normalizeFormatRepairGuidance(Array.from({ length: 9 }, () => "line")), null);
});


test("registered market rule IDs survive but unknown market strings and raw messages do not", () => {
  const raw = "RAW_MARKET_VALIDATION_MUST_NOT_ESCAPE";
  const schema = z.strictObject({ themes: z.array(z.string()) });
  const format = createStructuredResponseFormat(schema, "MarketDiagnosticTest@1.0.0");
  const error = new z.ZodError([
    { code: 'custom', path: ['themes', 0], message: raw, params: { ruleId: 'market-invalid-span' } },
    { code: 'custom', path: [raw], message: raw, params: { ruleId: `market-${raw}` } },
  ]);
  const issues = summarizeZodValidationIssues(error, format);
  assert.equal(issues[0].ruleId, 'market-invalid-span');
  assert.equal(issues[1].ruleId, undefined);
  assert.equal(freezeSafeValidationIssues(issues, format.format.schema)[0].ruleId, 'market-invalid-span');
  assert.equal(freezeSafeValidationIssues([{ code: 'custom', path: [], ruleId: `market-${raw}` }], format.format.schema)[0].ruleId, undefined);
  assert.doesNotMatch(JSON.stringify(issues), new RegExp(raw));
});
