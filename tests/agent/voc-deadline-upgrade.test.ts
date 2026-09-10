import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { openSqliteAgentRepository, registerVocSnapshotIntegrityFunction } from "../../server/db/sqlite-repository";
import { PostgresAgentRepository } from "../../server/db/postgres-repository";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { startPostgresTestContainer, type PostgresTestContainer } from "./helpers/postgres-test-container";

let postgres: PostgresTestContainer;
before(async () => { postgres = await startPostgresTestContainer(); });
after(async () => { await postgres?.close(); });

for (const dialect of ["sqlite", "postgres"] as const) {
  test(`${dialect}: actual 0029 upgrade preserves legacy publication counters and expires NULL-origin work`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "voc-deadline-upgrade-"));
    let closeDatabase = () => {};
    t.after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
    const path = join(directory, "legacy.sqlite");
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    if (dialect === "postgres") await postgres.pool.query(`CREATE SCHEMA ${schema}`);
    const pool = dialect === "postgres" ? postgres.createPool({ searchPath: schema }) : null;
    const db = dialect === "sqlite" ? new DatabaseSync(path) : null;
    if (db) registerVocSnapshotIntegrityFunction(db);
    closeDatabase = () => db?.close();
    const execute = async (sql: string, values: Array<string | number> = []) => {
      if (pool) { let i = 0; await pool.query(values.length ? sql.replace(/\?/g, () => `$${++i}`) : sql, values); }
      else if (values.length) db!.prepare(sql).run(...values);
      else db!.exec(sql);
    };
    const migrationDir = new URL(`../../server/db/migrations/${dialect === "postgres" ? "postgres/" : ""}`, import.meta.url);
    for (const filename of readdirSync(migrationDir).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 29).sort()) {
      const sql = readFileSync(new URL(filename, migrationDir), "utf8");
      await execute(sql);
      await execute("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        [Number(filename.slice(0, 4)), filename.slice(5, -4), createHash("sha256").update(dialect === "postgres" ? sql.replaceAll("\r\n", "\n") : sql).digest("hex"), "2026-09-09T00:00:00.000Z"]);
    }
    const actor = randomUUID(), org = randomUUID(), project = randomUUID(), run = randomUUID(), stage = randomUUID(), job = randomUUID();
    const now = "2026-09-09T00:00:00.000Z";
    await execute("INSERT INTO users (id, organization_id, email, display_name, role, status, created_at, updated_at) VALUES (?, ?, ?, 'fixture', 'admin', 'active', ?, ?)", [actor, org, actor + "@example.test", now, now]);
    await execute("INSERT INTO projects (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at) VALUES (?, ?, 'legacy', 'US', '[]', ?, ?, ?)", [project, org, actor, now, now]);
    await execute("INSERT INTO analysis_runs (id, project_id, mode, status, created_by, data_cutoff_at, idempotency_scope, idempotency_key, created_at, updated_at) VALUES (?, ?, 'existing-data', 'queued', ?, ?, ?, 'legacy', ?, ?)", [run, project, actor, now, run, now, now]);
    await execute("INSERT INTO run_stages (id, run_id, stage, status, progress, attempt_count, created_at, updated_at) VALUES (?, ?, 'alexa-voc-normalization', 'queued', 0, 1, ?, ?)", [stage, run, now, now]);
    const legacySnapshot = randomUUID();
    await execute(`INSERT INTO data_snapshots (id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
      sources_json, payload_json, content_hash, created_at, snapshot_kind, artifact_kind)
      VALUES (?, ?, '1.0.0', 'US', '["B012345678"]', ?, '[]', '{}', ?, ?, 'alexa-voc-normalization-input', 'alexa-voc-normalization-input')`,
      [legacySnapshot, run, now, "b".repeat(64), now]);
    await execute(`INSERT INTO job_attempts (id, stage_id, attempt_number, max_attempts, retry_cycle_start_attempt, logical_execution_cycle_id,
      report_publication_cycle, report_publication_attempt_count, report_publication_max_attempts,
      report_publication_initial_delay_ms, report_publication_max_delay_ms, report_publication_retry_at,
      status, available_at, lease_generation, retryable, created_at, updated_at)
      VALUES (?, ?, 1, 3, 1, ?, 1, 1, 3, 1000, 4000, ?, 'failed', ?, 0, TRUE, ?, ?)`,
      [job, stage, "a".repeat(64), now, now, now, now]);
    let repository;
    if (pool) {
      await runPostgresMigrations(pool);
      repository = new PostgresAgentRepository(pool);
      const origin = await pool.query("SELECT voc_deadline_started_at FROM job_attempts WHERE id=$1", [job]);
      assert.equal(origin.rows[0].voc_deadline_started_at, null);
      assert.deepEqual((await pool.query("SELECT snapshot_id, origin_job_id FROM alexa_voc_normalization_input_jobs")).rows, [{ snapshot_id: legacySnapshot, origin_job_id: job }]);
    } else {
      db!.close();
      closeDatabase = () => {};
      const sqliteRepository = openSqliteAgentRepository({ path, busyTimeoutMs: 5000 });
      repository = sqliteRepository;
      closeDatabase = () => sqliteRepository.close();
      const inspector = new DatabaseSync(path, { readOnly: true });
      assert.equal((inspector.prepare("SELECT voc_deadline_started_at FROM job_attempts WHERE id=?").get(job) as { voc_deadline_started_at: null }).voc_deadline_started_at, null);
      assert.deepEqual(inspector.prepare("SELECT snapshot_id, origin_job_id FROM alexa_voc_normalization_input_jobs").all().map(row => ({ ...row })), [{ snapshot_id: legacySnapshot, origin_job_id: job }]);
      inspector.close();
    }
    const before = (await repository.listJobAttempts(stage))[0];
    assert.equal(before.reportPublicationAttemptCount, 1);
    assert.equal(before.retryable, true);
    assert.equal(await repository.expireVocQueue({ checkedAt: "2026-09-09T00:05:00.000Z", timeoutMs: 300000 }), 1);
    const after = (await repository.listJobAttempts(stage))[0];
    assert.equal(after.error?.code, "QUEUE_TIMEOUT");
    assert.equal(after.reportPublicationAttemptCount, 1);
    assert.equal(after.reportPublicationMaxAttempts, 3);
    assert.equal(after.retryable, false);
    assert.equal(after.reportPublicationRetryAt, null);
    assert.equal(await repository.expireVocQueue({ checkedAt: "2026-09-09T00:05:01.000Z", timeoutMs: 300000 }), 0);
  });
}
