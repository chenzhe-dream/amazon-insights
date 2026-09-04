import { timingSafeEqual } from "node:crypto";

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type DingTalkOAuthStateCookieProfile = Readonly<{ secure: boolean }>;

export function serializeDingTalkOAuthStateCookie(
  state: string,
  profile: DingTalkOAuthStateCookieProfile,
): string {
  assertStateShape(state);
  return serializeStateCookie(state, profile, 300);
}

export function serializeClearedDingTalkOAuthStateCookie(
  profile: DingTalkOAuthStateCookieProfile,
): string {
  return serializeStateCookie("", profile, 0);
}

export function parseDingTalkOAuthStateCookie(
  cookieHeader: string | null | undefined,
  profile: DingTalkOAuthStateCookieProfile,
): string | null {
  if (!cookieHeader) return null;
  const name = cookieName(profile);
  const matches: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const [candidate, ...valueParts] = part.trim().split("=");
    if (candidate === name) matches.push(valueParts.join("="));
  }
  if (matches.length !== 1) return null;
  return STATE_PATTERN.test(matches[0]!) ? matches[0]! : null;
}

export function assertMatchingDingTalkOAuthState(
  queryState: string,
  cookieState: string | null,
): void {
  if (!STATE_PATTERN.test(queryState) || !cookieState || !STATE_PATTERN.test(cookieState)) {
    throw new Error("DingTalk OAuth state is invalid");
  }
  const query = Buffer.from(queryState, "ascii");
  const cookie = Buffer.from(cookieState, "ascii");
  if (query.length !== cookie.length || !timingSafeEqual(query, cookie)) {
    throw new Error("DingTalk OAuth state is invalid");
  }
}

function assertStateShape(state: string): void {
  if (!STATE_PATTERN.test(state)) {
    throw new TypeError("DingTalk OAuth state is invalid");
  }
}

function cookieName(profile: DingTalkOAuthStateCookieProfile): string {
  return profile.secure
    ? "__Host-dingtalk_oauth_state"
    : "dingtalk_oauth_state";
}

function serializeStateCookie(
  value: string,
  profile: DingTalkOAuthStateCookieProfile,
  maxAgeSeconds: number,
): string {
  return [
    `${cookieName(profile)}=${value}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    ...(profile.secure ? ["Secure"] : []),
    "SameSite=Lax",
  ].join("; ");
}
