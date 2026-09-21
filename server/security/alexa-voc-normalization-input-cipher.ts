import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { readManualAlexaVocRawReportKeyring } from "../config";
import {
  ManualAlexaVocCipherIntegrityError,
  ManualAlexaVocCipherUnavailableError,
} from "./manual-alexa-voc-cipher";

const ALGORITHM_VERSION = "AES-256-GCM/v1" as const;
const AAD_SCHEMA = "alexa-voc-normalization-input/v1" as const;
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 128 * 1024;
const KEY_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type AlexaVocNormalizationInputCipherIdentity = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  snapshotId: string;
  marketplace: "US";
  asin: string;
  schema: typeof AAD_SCHEMA;
}>;

export type AlexaVocNormalizationInputEncryptedEnvelope = Readonly<{
  algVersion: typeof ALGORITHM_VERSION;
  keyId: string;
  wrappedDek: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  aadSha256: string;
  plaintextBytes: number;
  plaintextSha256: string;
}>;

export interface AlexaVocNormalizationInputCipher {
  readonly activeKeyId: string;
  encrypt(input: Readonly<{
    identity: AlexaVocNormalizationInputCipherIdentity;
    plaintext: string;
  }>): AlexaVocNormalizationInputEncryptedEnvelope;
  decrypt(input: Readonly<{
    identity: AlexaVocNormalizationInputCipherIdentity;
    envelope: AlexaVocNormalizationInputEncryptedEnvelope;
  }>): string;
}

type Keyring = Readonly<{ activeKeyId: string; keys: ReadonlyMap<string, Buffer> }>;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validBounded(value: unknown, maximum = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function canonicalAad(identity: AlexaVocNormalizationInputCipherIdentity): Buffer {
  if (
    !validBounded(identity.organizationId) ||
    !validBounded(identity.projectId) ||
    !validBounded(identity.runId) ||
    !validBounded(identity.snapshotId) ||
    identity.marketplace !== "US" ||
    !/^[A-Z0-9]{10}$/.test(identity.asin) ||
    identity.schema !== AAD_SCHEMA
  ) {
    throw new ManualAlexaVocCipherIntegrityError();
  }
  return Buffer.from(JSON.stringify({
    organizationId: identity.organizationId,
    projectId: identity.projectId,
    runId: identity.runId,
    snapshotId: identity.snapshotId,
    marketplace: identity.marketplace,
    asin: identity.asin,
    schema: identity.schema,
  }), "utf8");
}

function parseKeyring(env: Readonly<Record<string, string | undefined>>): Keyring {
  const decoded: Buffer[] = [];
  try {
    const source = readManualAlexaVocRawReportKeyring(env);
    const parsed = source ? JSON.parse(source) as {
      activeKeyId?: unknown;
      keys?: Record<string, unknown>;
    } : null;
    if (!parsed || typeof parsed.activeKeyId !== "string" || !KEY_ID.test(parsed.activeKeyId) || !parsed.keys) {
      throw new Error("invalid keyring");
    }
    const keys = new Map<string, Buffer>();
    for (const [keyId, encoded] of Object.entries(parsed.keys)) {
      if (!KEY_ID.test(keyId) || typeof encoded !== "string" || !BASE64URL.test(encoded)) {
        throw new Error("invalid key");
      }
      const key = Buffer.from(encoded, "base64url");
      if (key.byteLength !== DEK_BYTES || key.toString("base64url") !== encoded) {
        key.fill(0);
        throw new Error("invalid key");
      }
      decoded.push(key);
      keys.set(keyId, key);
    }
    if (keys.size === 0 || !keys.has(parsed.activeKeyId)) throw new Error("active key missing");
    return Object.freeze({ activeKeyId: parsed.activeKeyId, keys });
  } catch {
    decoded.forEach(key => key.fill(0));
    throw new ManualAlexaVocCipherUnavailableError();
  }
}

function decode(value: string, bytes: number | null): Buffer {
  if (!BASE64URL.test(value)) throw new ManualAlexaVocCipherIntegrityError();
  const buffer = Buffer.from(value, "base64url");
  if (buffer.toString("base64url") !== value || (bytes !== null && buffer.byteLength !== bytes)) {
    buffer.fill(0);
    throw new ManualAlexaVocCipherIntegrityError();
  }
  return buffer;
}

function hashesEqual(left: string, right: string): boolean {
  return SHA256.test(left) && SHA256.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function wrapDek(dek: Buffer, keyId: string, kek: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(`alexa-voc-normalization-dek\0${keyId}`, "utf8"));
  return Buffer.concat([nonce, cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
}

function unwrapDek(value: Buffer, keyId: string, kek: Buffer): Buffer {
  if (value.byteLength !== NONCE_BYTES + DEK_BYTES + TAG_BYTES) {
    throw new ManualAlexaVocCipherIntegrityError();
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, value.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(`alexa-voc-normalization-dek\0${keyId}`, "utf8"));
    decipher.setAuthTag(value.subarray(value.byteLength - TAG_BYTES));
    return Buffer.concat([
      decipher.update(value.subarray(NONCE_BYTES, value.byteLength - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new ManualAlexaVocCipherIntegrityError();
  }
}

export function createAlexaVocNormalizationInputCipher(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AlexaVocNormalizationInputCipher {
  const keyring = parseKeyring(env);
  return Object.freeze<AlexaVocNormalizationInputCipher>({
    activeKeyId: keyring.activeKeyId,
    encrypt({ identity, plaintext }) {
      const aad = canonicalAad(identity);
      const plaintextBuffer = Buffer.from(plaintext, "utf8");
      if (plaintextBuffer.byteLength < 1 || plaintextBuffer.byteLength > MAX_PLAINTEXT_BYTES) {
        plaintextBuffer.fill(0);
        throw new ManualAlexaVocCipherIntegrityError();
      }
      const dek = randomBytes(DEK_BYTES);
      try {
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: TAG_BYTES });
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
        const wrappedDek = wrapDek(dek, keyring.activeKeyId, keyring.keys.get(keyring.activeKeyId)!);
        return Object.freeze({
          algVersion: ALGORITHM_VERSION,
          keyId: keyring.activeKeyId,
          wrappedDek: wrappedDek.toString("base64url"),
          nonce: nonce.toString("base64url"),
          ciphertext: ciphertext.toString("base64url"),
          tag: cipher.getAuthTag().toString("base64url"),
          aadSha256: sha256(aad),
          plaintextBytes: plaintextBuffer.byteLength,
          plaintextSha256: sha256(plaintextBuffer),
        });
      } finally {
        plaintextBuffer.fill(0);
        dek.fill(0);
      }
    },
    decrypt({ identity, envelope }) {
      const aad = canonicalAad(identity);
      if (
        envelope.algVersion !== ALGORITHM_VERSION ||
        !KEY_ID.test(envelope.keyId) ||
        !SHA256.test(envelope.aadSha256) ||
        !SHA256.test(envelope.plaintextSha256) ||
        !Number.isSafeInteger(envelope.plaintextBytes) ||
        envelope.plaintextBytes < 1 ||
        envelope.plaintextBytes > MAX_PLAINTEXT_BYTES ||
        !hashesEqual(envelope.aadSha256, sha256(aad))
      ) throw new ManualAlexaVocCipherIntegrityError();
      const kek = keyring.keys.get(envelope.keyId);
      if (!kek) throw new ManualAlexaVocCipherIntegrityError();
      const wrappedDek = decode(envelope.wrappedDek, NONCE_BYTES + DEK_BYTES + TAG_BYTES);
      const nonce = decode(envelope.nonce, NONCE_BYTES);
      const ciphertext = decode(envelope.ciphertext, envelope.plaintextBytes);
      const tag = decode(envelope.tag, TAG_BYTES);
      const dek = unwrapDek(wrappedDek, envelope.keyId, kek);
      try {
        const decipher = createDecipheriv("aes-256-gcm", dek, nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        if (plaintext.byteLength !== envelope.plaintextBytes || !hashesEqual(sha256(plaintext), envelope.plaintextSha256)) {
          plaintext.fill(0);
          throw new ManualAlexaVocCipherIntegrityError();
        }
        const result = plaintext.toString("utf8");
        plaintext.fill(0);
        return result;
      } catch (error) {
        if (error instanceof ManualAlexaVocCipherIntegrityError) throw error;
        throw new ManualAlexaVocCipherIntegrityError();
      } finally {
        wrappedDek.fill(0);
        nonce.fill(0);
        ciphertext.fill(0);
        tag.fill(0);
        dek.fill(0);
      }
    },
  });
}
