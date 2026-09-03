import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  createAlexaVocNormalizationInputCipher,
  type AlexaVocNormalizationInputCipherIdentity,
} from "../../server/security/alexa-voc-normalization-input-cipher";
import { ManualAlexaVocCipherIntegrityError } from "../../server/security/manual-alexa-voc-cipher";

const REPORT = "Alexa 七问原文：仅用于加密边界验证";
const identity: AlexaVocNormalizationInputCipherIdentity = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  projectId: "10000000-0000-4000-8000-000000000002",
  runId: "10000000-0000-4000-8000-000000000003",
  snapshotId: "10000000-0000-4000-8000-000000000004",
  marketplace: "US",
  asin: "B0ALEXA001",
  schema: "alexa-voc-normalization-input/v1",
};

function keyring() {
  return {
    MANUAL_VOC_RAW_REPORT_KEYRING: JSON.stringify({
      activeKeyId: "normalization-test",
      keys: { "normalization-test": randomBytes(32).toString("base64url") },
    }),
  };
}

test("normalization input cipher emits JSON-safe ciphertext and binds every AAD identity field", () => {
  const cipher = createAlexaVocNormalizationInputCipher(keyring());
  const envelope = cipher.encrypt({ identity, plaintext: REPORT });
  assert.equal(cipher.decrypt({ identity, envelope }), REPORT);
  assert.equal(JSON.stringify(envelope).includes(REPORT), false);
  for (const field of ["wrappedDek", "nonce", "ciphertext", "tag"] as const) {
    assert.equal(typeof envelope[field], "string");
    assert.match(envelope[field], /^[A-Za-z0-9_-]+$/);
  }

  const tampered: AlexaVocNormalizationInputCipherIdentity[] = [
    { ...identity, organizationId: "20000000-0000-4000-8000-000000000001" },
    { ...identity, projectId: "20000000-0000-4000-8000-000000000002" },
    { ...identity, runId: "20000000-0000-4000-8000-000000000003" },
    { ...identity, snapshotId: "20000000-0000-4000-8000-000000000004" },
    { ...identity, marketplace: "CA" as "US" },
    { ...identity, asin: "B0ALEXA002" },
    { ...identity, schema: "manual-alexa-voc/v2" as typeof identity.schema },
  ];
  for (const changed of tampered) {
    assert.throws(
      () => cipher.decrypt({ identity: changed, envelope }),
      ManualAlexaVocCipherIntegrityError,
    );
  }
});
