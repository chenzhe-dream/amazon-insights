import assert from "node:assert/strict";
import test from "node:test";

import {
  DUMMY_PASSWORD_RECORD,
  hashPassword,
  verifyPassword,
} from "../../server/auth/password";

test("scrypt password records use unique salts and verify only the correct password", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");

  assert.match(
    first,
    /^scrypt-v1\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/,
  );
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
});

test("scrypt password verification fails closed for malformed and excessive-cost records", async () => {
  assert.equal(await verifyPassword("password", "not-a-record"), false);

  const excessiveCostRecord =
    "scrypt-v1$32768$8$1$YWdlbnQtYXV0aC1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(await verifyPassword("password", excessiveCostRecord), false);
});

test("scrypt password hashing rejects out-of-bounds password lengths", async () => {
  await assert.rejects(() => hashPassword("1234567"), /Password length is invalid/);
  assert.match(await hashPassword("12345678"), /^scrypt-v1\$/);
  await assert.rejects(
    () => hashPassword("x".repeat(1_025)),
    /Password length is invalid/,
  );
});

test("dummy password record is closed-format and still performs one derivation", async () => {
  const fields = DUMMY_PASSWORD_RECORD.split("$");
  assert.equal(fields.length, 6);
  assert.equal(Buffer.from(fields[4] ?? "", "base64url").length, 16);
  assert.equal(Buffer.from(fields[5] ?? "", "base64url").length, 32);

  let calls = 0;
  const accepted = await verifyPassword(
    "submitted password",
    DUMMY_PASSWORD_RECORD,
    async () => {
      calls += 1;
      return Buffer.alloc(32, 1);
    },
  );

  assert.equal(accepted, false);
  assert.equal(calls, 1);
});
