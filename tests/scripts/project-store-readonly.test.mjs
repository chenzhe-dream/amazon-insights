import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readProjectReadonly } from "../../scripts/lib/project-store.mjs";

test("UUID-only readonly project reads never create, enumerate, write, or resolve a slug", () => {
  const originals = {
    mkdirSync: fs.mkdirSync,
    readdirSync: fs.readdirSync,
    writeFileSync: fs.writeFileSync,
  };
  const calls = [];
  fs.mkdirSync = () => {
    calls.push("mkdir");
    throw new Error("readonly read attempted mkdir");
  };
  fs.readdirSync = () => {
    calls.push("readdir");
    throw new Error("readonly read attempted enumeration");
  };
  fs.writeFileSync = () => {
    calls.push("write");
    throw new Error("readonly read attempted write");
  };

  try {
    assert.equal(readProjectReadonly("not-a-uuid-slug"), null);
    assert.equal(readProjectReadonly("ffffffff-ffff-4fff-8fff-ffffffffffff"), null);
    assert.deepEqual(calls, []);
  } finally {
    fs.mkdirSync = originals.mkdirSync;
    fs.readdirSync = originals.readdirSync;
    fs.writeFileSync = originals.writeFileSync;
  }
});
