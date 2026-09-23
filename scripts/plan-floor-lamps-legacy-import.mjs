import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import {
  FLOOR_LAMPS_LEGACY_PROJECT_ID,
  planFloorLampsLegacyImport,
} from "./lib/floor-lamps-legacy-import.mjs";

export async function readFloorLampsCanonicalFacts(client) {
  await client.connect();
  let begun = false;
  try {
    await client.query("BEGIN READ ONLY");
    begun = true;
    const bindingResult = await client.query(
      `SELECT legacy_project_id, organization_id, owner_user_id, operator_user_id, bound_at
       FROM legacy_project_owner_bindings WHERE legacy_project_id = $1`,
      [FLOOR_LAMPS_LEGACY_PROJECT_ID],
    );
    const row = bindingResult.rows[0] ?? null;
    const ownerResult = row ? await client.query(
      `SELECT id, organization_id, status FROM users WHERE id = $1`,
      [row.owner_user_id],
    ) : { rows: [] };
    const countsResult = await client.query(
      `SELECT (SELECT count(*) FROM projects WHERE id = $1)::text AS projects,
              (SELECT count(*) FROM analysis_runs WHERE project_id = $1)::text AS analysis_runs,
              (SELECT count(*) FROM sync_jobs WHERE project_id = $1)::text AS sync_jobs,
              (SELECT count(*) FROM project_display_versions WHERE project_id = $1)::text AS display_versions`,
      [FLOOR_LAMPS_LEGACY_PROJECT_ID],
    );
    const counts = countsResult.rows[0];
    return {
      binding: row ? {
        legacyProjectId: row.legacy_project_id,
        organizationId: row.organization_id,
        ownerUserId: row.owner_user_id,
        operatorUserId: row.operator_user_id,
        boundAt: new Date(row.bound_at).toISOString(),
      } : null,
      owner: ownerResult.rows[0] ? {
        id: ownerResult.rows[0].id,
        organizationId: ownerResult.rows[0].organization_id,
        status: ownerResult.rows[0].status,
      } : null,
      databaseCounts: {
        projects: Number(counts.projects),
        analysisRuns: Number(counts.analysis_runs),
        syncJobs: Number(counts.sync_jobs),
        displayVersions: Number(counts.display_versions),
      },
    };
  } finally {
    if (begun) await client.query("ROLLBACK");
    await client.end();
  }
}

function databaseUrl(runtimeRoot) {
  const env = fs.readFileSync(path.join(runtimeRoot, "formal-stack.env"), "utf8");
  const value = env.match(/^AGENT_DATABASE_URL=(.*)$/m)?.[1]?.trim();
  if (!value) throw new Error("AGENT_DATABASE_URL is absent from the runtime configuration");
  return value.replace(/^['"]|['"]$/g, "");
}

export async function runFloorLampsLegacyImportDryRun(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "--runtime-root") {
    throw new Error("Usage: node scripts/plan-floor-lamps-legacy-import.mjs --runtime-root <absolute-runtime-path>");
  }
  const runtimeRoot = path.resolve(argv[1]);
  const projectFile = path.join(runtimeRoot, "data", "projects", `${FLOOR_LAMPS_LEGACY_PROJECT_ID}.json`);
  const backupRoot = path.join(runtimeRoot, "backups", "pre-switch-20260901-123942574");
  const backupFile = path.join(backupRoot, "live-data", "projects", `${FLOOR_LAMPS_LEGACY_PROJECT_ID}.json`);
  const preSwitchManifest = JSON.parse(fs.readFileSync(path.join(backupRoot, "manifest.json"), "utf8"));
  const bindingManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "backups", "project-owner-bindings-20260910-054113", "manifest.json"), "utf8"));
  const client = new Client({ connectionString: databaseUrl(runtimeRoot) });
  const facts = await readFloorLampsCanonicalFacts(client);
  return planFloorLampsLegacyImport({
    projectBytes: fs.readFileSync(projectFile),
    backupBytes: fs.readFileSync(backupFile),
    preSwitchManifest,
    bindingManifest,
    ...facts,
  });
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runFloorLampsLegacyImportDryRun().then(
    preview => process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`),
    error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; },
  );
}
