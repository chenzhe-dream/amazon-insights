import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PRIMARY_ADMIN_EMAIL } from '../app/lib/primary-admin';

const config = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
  const split = line.indexOf('=');
  return [line.slice(0, split).trim(), line.slice(split + 1).trim().replace(/^(["'])(.*)\1$/, '$2')];
}));
const directory = path.join(config.AGENT_DATA_ROOT, 'projects');
const projects = fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))).filter(project => project.kind == null || project.kind === 'analysis');
const client = new pg.Client({ connectionString: config.AGENT_DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '5s'");
  const result = await client.query(`WITH scope AS (SELECT organization_id FROM users WHERE lower(email) = lower($1) AND role = 'admin' AND status = 'active'),
    files AS (SELECT unnest($2::text[]) AS id)
    SELECT (SELECT count(*) FROM scope)::int AS scope_count, count(*)::int AS total,
      count(*) FILTER (WHERE b.organization_id = (SELECT organization_id FROM scope))::int AS bound_current_organization,
      count(*) FILTER (WHERE b.organization_id IS NOT NULL AND b.organization_id <> (SELECT organization_id FROM scope))::int AS bound_other_organization,
      count(*) FILTER (WHERE b.legacy_project_id IS NULL)::int AS unbound
    FROM files f LEFT JOIN legacy_project_owner_bindings b ON b.legacy_project_id = f.id`, [PRIMARY_ADMIN_EMAIL, projects.map(project => project.id)]);
  const { scope_count, ...counts } = result.rows[0];
  if (scope_count !== 1) throw new Error('Cannot resolve a unique active configured administrator organization');
  console.log(JSON.stringify(counts));
  const associations = await client.query(`WITH scope AS (SELECT organization_id FROM users WHERE lower(email) = lower($1) AND role = 'admin' AND status = 'active'),
    files AS (SELECT unnest($2::text[]) AS id),
    links AS (
      SELECT id, organization_id FROM projects
      UNION SELECT project_id AS id, organization_id FROM project_creation_idempotency
      UNION SELECT project_id AS id, organization_id FROM sync_jobs WHERE project_id IS NOT NULL
      UNION SELECT legacy_project_id AS id, organization_id FROM legacy_project_owner_bindings
    ), stats AS (
      SELECT f.id,
        EXISTS(SELECT 1 FROM projects p WHERE p.id = f.id) AS canonical,
        EXISTS(SELECT 1 FROM analysis_runs r WHERE r.project_id = f.id) AS runs,
        EXISTS(SELECT 1 FROM sync_jobs j WHERE j.project_id = f.id) AS jobs,
        EXISTS(SELECT 1 FROM project_creation_idempotency i WHERE i.project_id = f.id) AS idempotency,
        (SELECT count(DISTINCT organization_id) FROM links l WHERE l.id = f.id) AS organizations,
        EXISTS(SELECT 1 FROM links l WHERE l.id = f.id AND l.organization_id = (SELECT organization_id FROM scope)) AS current_org,
        EXISTS(SELECT 1 FROM links l WHERE l.id = f.id AND l.organization_id <> (SELECT organization_id FROM scope)) AS other_org
      FROM files f)
    SELECT count(*)::int AS total,
      count(*) FILTER(WHERE canonical)::int AS canonical_id_match,
      count(*) FILTER(WHERE runs)::int AS analysis_run_id_match,
      count(*) FILTER(WHERE jobs)::int AS sync_job_id_match,
      count(*) FILTER(WHERE idempotency)::int AS idempotency_id_match,
      count(*) FILTER(WHERE organizations = 0)::int AS no_id_relation,
      count(*) FILTER(WHERE organizations = 1 AND current_org)::int AS one_current_org_relation,
      count(*) FILTER(WHERE organizations = 1 AND other_org)::int AS one_other_org_relation,
      count(*) FILTER(WHERE organizations > 1)::int AS conflicting_org_relations
    FROM stats`, [PRIMARY_ADMIN_EMAIL, projects.map(project => project.id)]);
  console.log(JSON.stringify(associations.rows[0]));
  await client.query('ROLLBACK');
} catch { console.error('Read-only binding audit failed; no private connection or account details emitted'); process.exitCode = 1; }
finally { await client.end(); }
