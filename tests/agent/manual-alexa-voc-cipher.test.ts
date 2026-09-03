import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  ManualAlexaVocCipherIntegrityError,
  ManualAlexaVocCipherUnavailableError,
  createManualAlexaVocCipher,
  type ManualAlexaVocEncryptedRaw,
} from "../../server/security/manual-alexa-voc-cipher";

const REPORT = [
  "manual-alexa-voc-report-sentinel",
  "买家喜欢结实、易清洁，并希望说明书更清楚。",
].join("\n");

const identity = Object.freeze({
  organizationId: "org-security-sentinel",
  marketplace: "US",
  asin: "B0SECURE01",
  revision: "1",
  normalizedSchemaVersion: "alexa-voc-record/v2",
  parserVersion: "deterministic-alexa-parser/v3",
});

const oldKek = Buffer.alloc(32, 0x31).toString("base64url");
const newKek = Buffer.alloc(32, 0x72).toString("base64url");

function keyring(
  activeKeyId: string,
  keys: Readonly<Record<string, string>>,
): Readonly<{ MANUAL_VOC_RAW_REPORT_KEYRING: string }> {
  return {
    MANUAL_VOC_RAW_REPORT_KEYRING: JSON.stringify({ activeKeyId, keys }),
  };
}

function flipByte(value: Uint8Array): Buffer {
  const copy = Buffer.from(value);
  copy[0] ^= 0xff;
  return copy;
}

function assertZeroized(buffers: readonly Buffer[]): void {
  assert.ok(buffers.length > 0);
  assert.ok(
    buffers.every((buffer) => buffer.every((byte) => byte === 0)),
    "captured sensitive buffers must be zeroized",
  );
}

function assertIntegrityFailureIsRedacted(
  operation: () => unknown,
  forbidden: readonly string[],
): void {
  const logs: string[] = [];
  const original = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  console.error = (...values: unknown[]) => logs.push(values.map(String).join(" "));
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
  console.warn = (...values: unknown[]) => logs.push(values.map(String).join(" "));

  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  } finally {
    console.error = original.error;
    console.log = original.log;
    console.warn = original.warn;
  }

  assert.ok(caught instanceof ManualAlexaVocCipherIntegrityError);
  assert.equal(
    caught.message,
    "Manual Alexa VOC raw report integrity check failed",
  );
  const observable = [caught.name, caught.message, ...logs].join("\n");
  for (const secret of forbidden.filter(Boolean)) {
    assert.equal(
      observable.includes(secret),
      false,
      `observable error output leaked ${secret}`,
    );
  }
}

test("manual Alexa VOC reports round-trip with a versioned per-record envelope", () => {
  const zeroizedPlaintext: Buffer[] = [];
  const zeroizedDeks: Buffer[] = [];
  const cipher = createManualAlexaVocCipher(
    keyring("old-2026-08", { "old-2026-08": oldKek }),
    {
      onPlaintextBufferZeroized(buffer) {
        zeroizedPlaintext.push(Buffer.from(buffer));
      },
      onDekBufferZeroized(buffer) {
        zeroizedDeks.push(Buffer.from(buffer));
      },
    },
  );

  const envelope = cipher.encrypt({ identity, plaintext: REPORT });

  assert.equal(envelope.algVersion, "AES-256-GCM/v1");
  assert.equal(envelope.keyId, "old-2026-08");
  assert.equal(envelope.wrappedDek.byteLength, 60);
  assert.equal(envelope.nonce.byteLength, 12);
  assert.equal(envelope.tag.byteLength, 16);
  assert.equal(envelope.ciphertext.byteLength, Buffer.byteLength(REPORT, "utf8"));
  assert.equal(envelope.plaintextBytes, Buffer.byteLength(REPORT, "utf8"));
  assert.match(envelope.aadSha256, /^[a-f0-9]{64}$/);
  assert.match(envelope.plaintextSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    Buffer.from(envelope.ciphertext).includes(Buffer.from(REPORT)),
    false,
  );
  assert.equal(cipher.decrypt({ identity, envelope }), REPORT);
  assertZeroized(zeroizedPlaintext);
  assertZeroized(zeroizedDeks);
});

test("each generated record has a unique keyId and nonce pair", () => {
  const cipher = createManualAlexaVocCipher(
    keyring("old-2026-08", { "old-2026-08": oldKek }),
  );
  const pairs = new Set<string>();

  for (let index = 0; index < 1_000; index += 1) {
    const envelope = cipher.encrypt({ identity, plaintext: REPORT });
    pairs.add(`${envelope.keyId}:${Buffer.from(envelope.nonce).toString("base64url")}`);
  }

  assert.equal(pairs.size, 1_000);
});

test("canonical AAD binds organization, marketplace, ASIN, revision, schema, and parser", () => {
  const cipher = createManualAlexaVocCipher(
    keyring("old-2026-08", { "old-2026-08": oldKek }),
  );
  const envelope = cipher.encrypt({ identity, plaintext: REPORT });
  const aadJson = JSON.stringify(identity);
  const forbidden = [
    REPORT,
    aadJson,
    Buffer.from(envelope.nonce).toString("base64url"),
    Buffer.from(envelope.tag).toString("base64url"),
    Buffer.from(envelope.wrappedDek).toString("base64url"),
    Buffer.from(envelope.ciphertext).toString("base64url"),
  ];

  const mismatches = [
    { ...identity, organizationId: "org-other" },
    { ...identity, marketplace: "CA" },
    { ...identity, asin: "B0OTHER001" },
    { ...identity, revision: "2" },
    { ...identity, normalizedSchemaVersion: "alexa-voc-record/v999" },
    { ...identity, parserVersion: "deterministic-alexa-parser/v999" },
  ];
  for (const mismatch of mismatches) {
    assertIntegrityFailureIsRedacted(
      () => cipher.decrypt({ identity: mismatch, envelope }),
      forbidden,
    );
  }
});

test("ciphertext, tag, wrapped DEK, and authenticated metadata tampering fail closed", () => {
  const zeroizedDeks: Buffer[] = [];
  const cipher = createManualAlexaVocCipher(
    keyring("old-2026-08", { "old-2026-08": oldKek }),
    {
      onDekBufferZeroized(buffer) {
        zeroizedDeks.push(Buffer.from(buffer));
      },
    },
  );
  const envelope = cipher.encrypt({ identity, plaintext: REPORT });
  const aadJson = JSON.stringify(identity);
  const forbidden = [
    REPORT,
    aadJson,
    Buffer.from(envelope.nonce).toString("base64url"),
    Buffer.from(envelope.tag).toString("base64url"),
    Buffer.from(envelope.wrappedDek).toString("base64url"),
    Buffer.from(envelope.ciphertext).toString("base64url"),
  ];
  const mutations: ManualAlexaVocEncryptedRaw[] = [
    { ...envelope, ciphertext: flipByte(envelope.ciphertext) },
    { ...envelope, tag: flipByte(envelope.tag) },
    { ...envelope, wrappedDek: flipByte(envelope.wrappedDek) },
    { ...envelope, aadSha256: "f".repeat(64) },
    { ...envelope, plaintextSha256: "e".repeat(64) },
    { ...envelope, plaintextBytes: envelope.plaintextBytes + 1 },
  ];

  for (const tampered of mutations) {
    assertIntegrityFailureIsRedacted(
      () => cipher.decrypt({ identity, envelope: tampered }),
      forbidden,
    );
  }
  assertZeroized(zeroizedDeks);

  assertIntegrityFailureIsRedacted(
    () => cipher.rewrap({ envelope: mutations[2] }),
    forbidden,
  );
});

test("rotation rewraps only the DEK and keeps encrypted content unchanged", () => {
  const oldCipher = createManualAlexaVocCipher(
    keyring("old-2026-08", { "old-2026-08": oldKek }),
  );
  const envelope = oldCipher.encrypt({ identity, plaintext: REPORT });
  const rotatingCipher = createManualAlexaVocCipher(
    keyring("new-2026-09", {
      "old-2026-08": oldKek,
      "new-2026-09": newKek,
    }),
  );

  assert.equal(rotatingCipher.decrypt({ identity, envelope }), REPORT);
  const rewrapped = rotatingCipher.rewrap({ envelope });

  assert.equal(rewrapped.keyId, "new-2026-09");
  assert.notDeepEqual(rewrapped.wrappedDek, envelope.wrappedDek);
  assert.strictEqual(rewrapped.ciphertext, envelope.ciphertext);
  assert.strictEqual(rewrapped.nonce, envelope.nonce);
  assert.strictEqual(rewrapped.tag, envelope.tag);
  assert.equal(rewrapped.algVersion, envelope.algVersion);
  assert.equal(rewrapped.aadSha256, envelope.aadSha256);
  assert.equal(rewrapped.plaintextBytes, envelope.plaintextBytes);
  assert.equal(rewrapped.plaintextSha256, envelope.plaintextSha256);
  assert.equal(rotatingCipher.decrypt({ identity, envelope: rewrapped }), REPORT);
  assert.throws(
    () => oldCipher.decrypt({ identity, envelope: rewrapped }),
    ManualAlexaVocCipherIntegrityError,
  );
});

test("keyring and plaintext bounds fail closed without exposing configuration", () => {
  const invalidKeyrings = [
    undefined,
    "",
    "not-json-keyring-sentinel",
    JSON.stringify({ activeKeyId: "missing", keys: {} }),
    JSON.stringify({ activeKeyId: "bad", keys: { bad: "not-a-kek-sentinel" } }),
    JSON.stringify({
      activeKeyId: "missing",
      keys: { present: oldKek },
    }),
  ];
  for (const encoded of invalidKeyrings) {
    assert.throws(
      () => createManualAlexaVocCipher({
        MANUAL_VOC_RAW_REPORT_KEYRING: encoded,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManualAlexaVocCipherUnavailableError);
        assert.equal(
          error.message,
          "Manual Alexa VOC raw report encryption is unavailable",
        );
        assert.doesNotMatch(
          error.message,
          /not-json|not-a-kek|missing|present|MTEx|cnJy/i,
        );
        return true;
      },
    );
  }

  const zeroizedPlaintext: Buffer[] = [];
  const cipher = createManualAlexaVocCipher(
    keyring("old-2026-08", { "old-2026-08": oldKek }),
    {
      onPlaintextBufferZeroized(buffer) {
        zeroizedPlaintext.push(Buffer.from(buffer));
      },
    },
  );
  for (const plaintext of ["", "é".repeat(65_537)]) {
    assert.throws(
      () => cipher.encrypt({ identity, plaintext }),
      ManualAlexaVocCipherIntegrityError,
    );
  }
  assertZeroized(zeroizedPlaintext);

  const maximum = "x".repeat(131_072);
  const maximumEnvelope = cipher.encrypt({ identity, plaintext: maximum });
  assert.equal(maximumEnvelope.plaintextBytes, 131_072);
  assert.equal(cipher.decrypt({ identity, envelope: maximumEnvelope }), maximum);
});
