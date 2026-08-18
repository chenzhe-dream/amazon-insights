import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const PROFILE = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
  maxmem: 67_108_864,
});

export const DUMMY_PASSWORD_RECORD =
  "scrypt-v1$16384$8$1$YWdlbnQtYXV0aC1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export type PasswordDeriver = (
  password: string,
  salt: Buffer,
) => Promise<Buffer>;

const PASSWORD_RECORD_PATTERN =
  /^scrypt-v1\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1_024) {
    throw new Error("Password length is invalid");
  }

  const salt = randomBytes(PROFILE.saltLength);
  const key = await derivePassword(password, salt);
  return [
    "scrypt-v1",
    String(PROFILE.N),
    String(PROFILE.r),
    String(PROFILE.p),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string,
  derive: PasswordDeriver = derivePassword,
): Promise<boolean> {
  try {
    const parsed = parsePasswordRecord(encoded);
    const candidateKey = await derive(password, parsed.salt);
    if (candidateKey.length !== parsed.key.length) return false;
    return timingSafeEqual(candidateKey, parsed.key);
  } catch {
    return false;
  }
}

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      PROFILE.keyLength,
      {
        N: PROFILE.N,
        r: PROFILE.r,
        p: PROFILE.p,
        maxmem: PROFILE.maxmem,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.from(derivedKey));
      },
    );
  });
}

function parsePasswordRecord(encoded: string): { salt: Buffer; key: Buffer } {
  const match = PASSWORD_RECORD_PATTERN.exec(encoded);
  if (!match) {
    throw new Error("Invalid password record");
  }

  const [, n, r, p, saltText, keyText] = match;
  if (
    n !== String(PROFILE.N) ||
    r !== String(PROFILE.r) ||
    p !== String(PROFILE.p)
  ) {
    throw new Error("Invalid password record");
  }

  const salt = Buffer.from(saltText ?? "", "base64url");
  const key = Buffer.from(keyText ?? "", "base64url");
  if (salt.length !== PROFILE.saltLength || key.length !== PROFILE.keyLength) {
    throw new Error("Invalid password record");
  }

  return { salt, key };
}
