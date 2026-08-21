import { createHash, randomBytes } from "node:crypto";

export interface SessionCookieProfile {
  name: string;
  secure: boolean;
  maxAgeSeconds: number;
}

export interface SessionToken {
  rawToken: string;
  tokenHash: string;
}

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createSessionToken(
  generateBytes: (size: number) => Buffer = randomBytes,
): SessionToken {
  const tokenBytes = generateBytes(32);
  if (tokenBytes.length !== 32) {
    throw new Error("Session token entropy source returned invalid length");
  }

  const rawToken = tokenBytes.toString("base64url");
  return Object.freeze({
    rawToken,
    tokenHash: digestSessionToken(rawToken),
  });
}

export function digestSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function parseSessionCookie(
  cookieHeader: string | null | undefined,
  profile: SessionCookieProfile,
): string | null {
  if (!cookieHeader) return null;

  const matches: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== profile.name) continue;
    matches.push(valueParts.join("="));
  }

  if (matches.length !== 1) return null;
  const [rawToken] = matches;
  return rawToken && SESSION_TOKEN_PATTERN.test(rawToken) ? rawToken : null;
}

export function serializeSessionCookie(
  rawToken: string,
  profile: SessionCookieProfile,
): string {
  assertSessionToken(rawToken);
  return serializeCookieValue(rawToken, profile, profile.maxAgeSeconds);
}

export function serializeClearedSessionCookie(
  profile: SessionCookieProfile,
): string {
  return serializeCookieValue("", profile, 0);
}

function serializeCookieValue(
  value: string,
  profile: SessionCookieProfile,
  maxAgeSeconds: number,
): string {
  return `${profile.name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly${
    profile.secure ? "; Secure" : ""
  }; SameSite=Lax`;
}

function assertSessionToken(rawToken: string): void {
  if (!SESSION_TOKEN_PATTERN.test(rawToken)) {
    throw new Error("Session token is invalid");
  }
}
