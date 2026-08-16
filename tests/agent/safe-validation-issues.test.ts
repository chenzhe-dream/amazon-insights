import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { summarizeZodValidationIssues } from "../../server/runtime/safe-validation-issues";
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
