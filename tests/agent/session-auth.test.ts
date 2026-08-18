import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createSessionToken,
  digestSessionToken,
  parseSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "../../server/auth/session";

const secureProfile = Object.freeze({
  name: "__Host-agent_session",
  secure: true,
  maxAgeSeconds: 28_800,
});

const insecureProfile = Object.freeze({
  name: "agent_session",
  secure: false,
  maxAgeSeconds: 28_800,
});

test("session tokens expose only base64url raw text and lowercase SHA-256 digests", () => {
  const token = createSessionToken(() => Buffer.alloc(32, 7));

  assert.match(token.rawToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(token.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(
    token.tokenHash,
    createHash("sha256").update(token.rawToken).digest("hex"),
  );
  assert.equal(digestSessionToken(token.rawToken), token.tokenHash);
});

test("session cookie parser accepts exactly one well-formed profile cookie", () => {
  const token = createSessionToken(() => Buffer.alloc(32, 8));

  assert.equal(
    parseSessionCookie(
      `${secureProfile.name}=${token.rawToken}; theme=dark`,
      secureProfile,
    ),
    token.rawToken,
  );
  assert.equal(parseSessionCookie("theme=dark", secureProfile), null);
  assert.equal(
    parseSessionCookie(`${secureProfile.name}=not-valid`, secureProfile),
    null,
  );
  assert.equal(
    parseSessionCookie(
      `${secureProfile.name}=${token.rawToken}; ${secureProfile.name}=${token.rawToken}`,
      secureProfile,
    ),
    null,
  );
});

test("session cookies serialize exact secure and insecure attributes without Domain", () => {
  const raw = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

  assert.equal(
    serializeSessionCookie(raw, secureProfile),
    "__Host-agent_session=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Lax",
  );
  assert.equal(
    serializeSessionCookie(raw, insecureProfile),
    "agent_session=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc; Max-Age=28800; Path=/; HttpOnly; SameSite=Lax",
  );
  assert.equal(
    serializeClearedSessionCookie(secureProfile),
    "__Host-agent_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
  );
  assert.equal(
    serializeClearedSessionCookie(insecureProfile),
    "agent_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
  );

  const serialized = [
    serializeSessionCookie(raw, secureProfile),
    serializeSessionCookie(raw, insecureProfile),
    serializeClearedSessionCookie(secureProfile),
    serializeClearedSessionCookie(insecureProfile),
  ].join("\n");
  assert.doesNotMatch(serialized, /Domain=/i);
});
