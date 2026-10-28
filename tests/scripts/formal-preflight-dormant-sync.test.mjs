import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const url = process.env.AGENT_DATABASE_URL;
test('publication distinguishes completed sync placeholders from executable work', { skip: !url }, async () => {
  const target = new URL(url);
  assert.equal(target.port, '64733', 'integration test is candidate-only');
  assert.equal(target.pathname, '/amazon_reviews_four_market_20261026');
  const source = await readFile(new URL('../../scripts/manage-formal-stack.ps1', import.meta.url), 'utf8');
  const query = source.match(/const \{ rows \} = await client\.query\(`([\s\S]*?)`\);/)[1];
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE sync_jobs(job_id text,run_id text,project_id text,actor_id text,organization_id text,status text,leased_by text,lease_expires_at timestamptz);
      CREATE TEMP TABLE analysis_runs(id text,project_id text,created_by text,idempotency_scope text,idempotency_key text,status text);
      CREATE TEMP TABLE run_stages(id text,run_id text,stage text,status text,attempt_count int,started_at timestamptz);
      CREATE TEMP TABLE job_attempts(stage_id text,status text);
      CREATE TEMP TABLE market_analysis_steps(status text);
    `);
    const seed = async () => {
      await client.query(`TRUNCATE sync_jobs,analysis_runs,run_stages,job_attempts,market_analysis_steps;
        INSERT INTO sync_jobs VALUES('job','run','project','actor','org','completed',NULL,NULL);
        INSERT INTO analysis_runs VALUES('run','project','actor','sync:org:project','job','queued');
        INSERT INTO run_stages VALUES('stage','run','traffic-analysis','queued',0,NULL);`);
    };
    await seed();
    assert.equal((await client.query(query)).rows[0].active, 0, 'completed sync with an untouched placeholder is idle');
    for (const mutation of [
      "UPDATE sync_jobs SET status='running'",
      "UPDATE sync_jobs SET status='queued'",
      "UPDATE sync_jobs SET status='failed'",
      "UPDATE sync_jobs SET leased_by='worker'",
      "UPDATE sync_jobs SET lease_expires_at=now()+interval '1 hour'",
      "UPDATE analysis_runs SET idempotency_key='unrelated'",
      "UPDATE analysis_runs SET status='running'",
      "UPDATE run_stages SET status='running'",
      "UPDATE run_stages SET attempt_count=1",
      "UPDATE run_stages SET started_at=now()",
      "INSERT INTO run_stages VALUES('other','run','voc-positioning','queued',0,NULL)",
      "INSERT INTO job_attempts VALUES('stage','queued')",
      "INSERT INTO job_attempts VALUES('stage','succeeded')",
      "INSERT INTO market_analysis_steps VALUES('queued')",
    ]) {
      await seed();
      await client.query(mutation);
      assert.ok((await client.query(query)).rows[0].active > 0, mutation);
    }
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
