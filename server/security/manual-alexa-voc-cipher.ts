import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { TextDecoder } from "node:util";

import { readManualAlexaVocRawReportKeyring } from "../config";

const ALGORITHM_VERSION = "AES-256-GCM/v1" as const;
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_DEK_BYTES = NONCE_BYTES + DEK_BYTES + TAG_BYTES;
const MAX_PLAINTEXT_BYTES = 131_072;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

type ManualAlexaVocIdentity = Readonly<{
  organizationId: string;
  marketplace: string;
  asin: string;
  revision: string;
  normalizedSchemaVersion: string;
  parserVersion: string;
}>;

type ManualAlexaVocCipherEnvironment = Readonly<
  Record<string, string | undefined>
>;

type ManualAlexaVocCipherTestHooks = Readonly<{
  onPlaintextBufferZeroized?: (buffer: Buffer) => void;
  onDekBufferZeroized?: (buffer: Buffer) => void;
}>;

type ParsedKeyring = Readonly<{
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}>;

export type ManualAlexaVocEncryptedRaw = Readonly<{
  algVersion: "AES-256-GCM/v1";
  keyId: string;
  wrappedDek: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
  aadSha256: string;
  plaintextBytes: number;
  plaintextSha256: string;
}>;

export class ManualAlexaVocCipherUnavailableError extends Error {
  constructor() {
    super("Manual Alexa VOC raw report encryption is unavailable");
    this.name = "ManualAlexaVocCipherUnavailableError";
  }
}

export class ManualAlexaVocCipherIntegrityError extends Error {
  constructor() {
    super("Manual Alexa VOC raw report integrity check failed");
    this.name = "ManualAlexaVocCipherIntegrityError";
  }
}

export interface ManualAlexaVocCipher {
  readonly activeKeyId: string;
  encrypt(input: Readonly<{
    identity: ManualAlexaVocIdentity;
    plaintext: string;
  }>): ManualAlexaVocEncryptedRaw;
  decrypt(input: Readonly<{
    identity: ManualAlexaVocIdentity;
    envelope: ManualAlexaVocEncryptedRaw;
  }>): string;
  rewrap(input: Readonly<{
    envelope: ManualAlexaVocEncryptedRaw;
  }>): ManualAlexaVocEncryptedRaw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKeyring(env: ManualAlexaVocCipherEnvironment): ParsedKeyring {
  const decodedKeys: Buffer[] = [];
  try {
    const encoded = readManualAlexaVocRawReportKeyring(env);
    if (!encoded) throw new Error("missing keyring");
    const parsed: unknown = JSON.parse(encoded);
    if (!isRecord(parsed) || !isRecord(parsed.keys)) {
      throw new Error("invalid keyring");
    }
    if (typeof parsed.activeKeyId !== "string" || !KEY_ID.test(parsed.activeKeyId)) {
      throw new Error("invalid active key id");
    }

    const entries = Object.entries(parsed.keys);
    if (entries.length === 0) throw new Error("empty keyring");
    const keys = new Map<string, Buffer>();
    for (const [keyId, encodedKek] of entries) {
      if (
        !KEY_ID.test(keyId) ||
        typeof encodedKek !== "string" ||
        !BASE64URL_32_BYTES.test(encodedKek)
      ) {
        throw new Error("invalid key");
      }
      const kek = Buffer.from(encodedKek, "base64url");
      if (
        kek.byteLength !== DEK_BYTES ||
        kek.toString("base64url") !== encodedKek
      ) {
        kek.fill(0);
        throw new Error("invalid key");
      }
      decodedKeys.push(kek);
      keys.set(keyId, kek);
    }
    if (!keys.has(parsed.activeKeyId)) {
      throw new Error("active key missing");
    }
    return Object.freeze({ activeKeyId: parsed.activeKeyId, keys });
  } catch {
    for (const kek of decodedKeys) kek.fill(0);
    throw new ManualAlexaVocCipherUnavailableError();
  }
}

function canonicalAad(identity: ManualAlexaVocIdentity): Buffer {
  if (
    !isBoundedText(identity.organizationId, 200) ||
    identity.marketplace !== "US" ||
    !/^[A-Z0-9]{10}$/.test(identity.asin) ||
    !/^[1-9]\d*$/.test(identity.revision) ||
    identity.revision.length > 20 ||
    !isBoundedText(identity.normalizedSchemaVersion, 200) ||
    !isBoundedText(identity.parserVersion, 200)
  ) {
    throw new ManualAlexaVocCipherIntegrityError();
  }
  return Buffer.from(
    JSON.stringify({
      organizationId: identity.organizationId,
      marketplace: identity.marketplace,
      asin: identity.asin,
      revision: identity.revision,
      normalizedSchemaVersion: identity.normalizedSchemaVersion,
      parserVersion: identity.parserVersion,
    }),
    "utf8",
  );
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function assertEnvelope(envelope: ManualAlexaVocEncryptedRaw): void {
  if (
    !envelope ||
    envelope.algVersion !== ALGORITHM_VERSION ||
    !KEY_ID.test(envelope.keyId) ||
    !(envelope.wrappedDek instanceof Uint8Array) ||
    envelope.wrappedDek.byteLength !== WRAPPED_DEK_BYTES ||
    !(envelope.nonce instanceof Uint8Array) ||
    envelope.nonce.byteLength !== NONCE_BYTES ||
    !(envelope.ciphertext instanceof Uint8Array) ||
    envelope.ciphertext.byteLength < 1 ||
    envelope.ciphertext.byteLength > MAX_PLAINTEXT_BYTES ||
    !(envelope.tag instanceof Uint8Array) ||
    envelope.tag.byteLength !== TAG_BYTES ||
    !SHA256_HEX.test(envelope.aadSha256) ||
    !Number.isSafeInteger(envelope.plaintextBytes) ||
    envelope.plaintextBytes !== envelope.ciphertext.byteLength ||
    !SHA256_HEX.test(envelope.plaintextSha256)
  ) {
    throw new ManualAlexaVocCipherIntegrityError();
  }
}

function zeroize(
  buffer: Buffer | null,
  callback: ((buffer: Buffer) => void) | undefined,
): void {
  if (!buffer) return;
  buffer.fill(0);
  callback?.(buffer);
}

function wrapDek(dek: Buffer, keyId: string, kek: Buffer): Buffer {
  const wrapNonce = randomBytes(NONCE_BYTES);
  const wrapper = createCipheriv("aes-256-gcm", kek, wrapNonce, {
    authTagLength: TAG_BYTES,
  });
  wrapper.setAAD(Buffer.from(`manual-voc-dek\0${keyId}`, "utf8"));
  return Buffer.concat([
    wrapNonce,
    wrapper.update(dek),
    wrapper.final(),
    wrapper.getAuthTag(),
  ]);
}

function unwrapDek(
  wrappedDek: Uint8Array,
  keyId: string,
  kek: Buffer,
  hooks: ManualAlexaVocCipherTestHooks,
): Buffer {
  let updated: Buffer | null = null;
  let final: Buffer | null = null;
  try {
    const wrapped = Buffer.from(wrappedDek);
    const wrapNonce = wrapped.subarray(0, NONCE_BYTES);
    const encryptedDek = wrapped.subarray(NONCE_BYTES, NONCE_BYTES + DEK_BYTES);
    const wrapTag = wrapped.subarray(NONCE_BYTES + DEK_BYTES);
    const unwrapper = createDecipheriv("aes-256-gcm", kek, wrapNonce, {
      authTagLength: TAG_BYTES,
    });
    unwrapper.setAAD(Buffer.from(`manual-voc-dek\0${keyId}`, "utf8"));
    unwrapper.setAuthTag(wrapTag);
    updated = unwrapper.update(encryptedDek);
    final = unwrapper.final();
    const dek = Buffer.concat([updated, final]);
    if (dek.byteLength !== DEK_BYTES) {
      dek.fill(0);
      throw new Error("invalid DEK");
    }
    return dek;
  } finally {
    zeroize(updated, hooks.onDekBufferZeroized);
    zeroize(final, hooks.onDekBufferZeroized);
  }
}

export function createManualAlexaVocCipher(
  env: ManualAlexaVocCipherEnvironment = process.env,
  hooks: ManualAlexaVocCipherTestHooks = {},
): ManualAlexaVocCipher {
  const keyring = parseKeyring(env);
  const activeKek = keyring.keys.get(keyring.activeKeyId)!;

  return Object.freeze({
    activeKeyId: keyring.activeKeyId,
    encrypt(input: Readonly<{
      identity: ManualAlexaVocIdentity;
      plaintext: string;
    }>): ManualAlexaVocEncryptedRaw {
      let plaintext: Buffer | null = null;
      let dek: Buffer | null = null;
      try {
        const aad = canonicalAad(input.identity);
        if (typeof input.plaintext !== "string") {
          throw new ManualAlexaVocCipherIntegrityError();
        }
        plaintext = Buffer.from(input.plaintext, "utf8");
        if (
          plaintext.byteLength < 1 ||
          plaintext.byteLength > MAX_PLAINTEXT_BYTES
        ) {
          throw new ManualAlexaVocCipherIntegrityError();
        }
        dek = randomBytes(DEK_BYTES);
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", dek, nonce, {
          authTagLength: TAG_BYTES,
        });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]);
        const envelope: ManualAlexaVocEncryptedRaw = {
          algVersion: ALGORITHM_VERSION,
          keyId: keyring.activeKeyId,
          wrappedDek: wrapDek(dek, keyring.activeKeyId, activeKek),
          nonce,
          ciphertext,
          tag: cipher.getAuthTag(),
          aadSha256: sha256(aad),
          plaintextBytes: plaintext.byteLength,
          plaintextSha256: sha256(plaintext),
        };
        return Object.freeze(envelope);
      } catch (error) {
        if (error instanceof ManualAlexaVocCipherIntegrityError) throw error;
        throw new ManualAlexaVocCipherIntegrityError();
      } finally {
        zeroize(plaintext, hooks.onPlaintextBufferZeroized);
        zeroize(dek, hooks.onDekBufferZeroized);
      }
    },

    decrypt(input: Readonly<{
      identity: ManualAlexaVocIdentity;
      envelope: ManualAlexaVocEncryptedRaw;
    }>): string {
      let dek: Buffer | null = null;
      let updated: Buffer | null = null;
      let final: Buffer | null = null;
      let plaintext: Buffer | null = null;
      try {
        assertEnvelope(input.envelope);
        const aad = canonicalAad(input.identity);
        if (!hashesEqual(input.envelope.aadSha256, sha256(aad))) {
          throw new Error("AAD mismatch");
        }
        const kek = keyring.keys.get(input.envelope.keyId);
        if (!kek) throw new Error("unknown key");
        dek = unwrapDek(
          input.envelope.wrappedDek,
          input.envelope.keyId,
          kek,
          hooks,
        );
        const decipher = createDecipheriv(
          "aes-256-gcm",
          dek,
          input.envelope.nonce,
          { authTagLength: TAG_BYTES },
        );
        decipher.setAAD(aad);
        decipher.setAuthTag(input.envelope.tag);
        updated = decipher.update(input.envelope.ciphertext);
        final = decipher.final();
        plaintext = Buffer.concat([updated, final]);
        if (
          plaintext.byteLength !== input.envelope.plaintextBytes ||
          !hashesEqual(input.envelope.plaintextSha256, sha256(plaintext))
        ) {
          throw new Error("plaintext metadata mismatch");
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } catch {
        throw new ManualAlexaVocCipherIntegrityError();
      } finally {
        zeroize(updated, hooks.onPlaintextBufferZeroized);
        zeroize(final, hooks.onPlaintextBufferZeroized);
        zeroize(plaintext, hooks.onPlaintextBufferZeroized);
        zeroize(dek, hooks.onDekBufferZeroized);
      }
    },

    rewrap(input: Readonly<{
      envelope: ManualAlexaVocEncryptedRaw;
    }>): ManualAlexaVocEncryptedRaw {
      let dek: Buffer | null = null;
      try {
        assertEnvelope(input.envelope);
        const oldKek = keyring.keys.get(input.envelope.keyId);
        if (!oldKek) throw new Error("unknown key");
        dek = unwrapDek(
          input.envelope.wrappedDek,
          input.envelope.keyId,
          oldKek,
          hooks,
        );
        return Object.freeze({
          ...input.envelope,
          keyId: keyring.activeKeyId,
          wrappedDek: wrapDek(dek, keyring.activeKeyId, activeKek),
        });
      } catch {
        throw new ManualAlexaVocCipherIntegrityError();
      } finally {
        zeroize(dek, hooks.onDekBufferZeroized);
      }
    },
  });
}
