import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("SQLite and PostgreSQL normalization terminals append by job attempt", async () => {
  const [sqlite, postgres] = await Promise.all([
    readFile("server/db/migrations/0024_alexa_voc_normalization_attempts.sql", "utf8"),
    readFile("server/db/migrations/postgres/0024_alexa_voc_normalization_attempts.sql", "utf8"),
  ]);
  assert.match(sqlite, /job_attempt_id TEXT PRIMARY KEY/i);
  assert.doesNotMatch(sqlite, /snapshot_id TEXT PRIMARY KEY/i);
  assert.match(postgres, /DROP CONSTRAINT alexa_voc_normalization_terminals_pkey/i);
  assert.match(postgres, /ADD PRIMARY KEY \(job_attempt_id\)/i);
  for (const migration of [sqlite, postgres]) {
    assert.match(migration, /alexa_voc_normalization_terminals_snapshot_idx/i);
  }
});
