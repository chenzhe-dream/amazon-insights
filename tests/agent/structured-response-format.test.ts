import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import { createStructuredResponseFormat } from "../../server/runtime/structured-response-format";

test("strict response format and digest are stable and derived from the same pure JSON", () => {
  const schema = z.object({ summary: z.string() }).strict();
  const first = createStructuredResponseFormat(
    schema,
    "VocPositioningOutput@1.0.0",
  );
  const second = createStructuredResponseFormat(
    schema,
    "VocPositioningOutput@1.0.0",
  );

  assert.deepEqual(first, second);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(first.digest, canonicalJsonSha256(first.format));
  assert.deepEqual(Object.keys(first.format).sort(), [
    "name",
    "schema",
    "strict",
    "type",
  ]);
  assert.equal(first.format.type, "json_schema");
  assert.equal(first.format.name, "VocPositioningOutput_1_0_0");
  assert.equal(first.format.strict, true);
  assert.equal(Object.hasOwn(first.format, "$parseRaw"), false);
  assert.equal(Object.hasOwn(first.format, "$brand"), false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.format), true);
  assert.equal(Object.isFrozen(first.format.schema), true);
  assert.throws(
    () =>
      Object.assign(first.format.schema, {
        injected: "mutation",
      }),
    TypeError,
  );
});

test("same contract name with a different Zod schema produces a different digest", () => {
  const first = createStructuredResponseFormat(
    z.object({ summary: z.string() }).strict(),
    "Output@1.0.0",
  );
  const second = createStructuredResponseFormat(
    z.object({ summary: z.string(), confidence: z.number() }).strict(),
    "Output@1.0.0",
  );

  assert.notEqual(first.digest, second.digest);
  assert.notDeepEqual(first.format.schema, second.format.schema);
});
