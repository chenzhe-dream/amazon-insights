import assert from "node:assert/strict";
import test from "node:test";

import { readFloorLampsCanonicalFacts } from "../../scripts/plan-floor-lamps-legacy-import.mjs";

test("database facts are read in a rollback-only transaction", async () => {
  const statements = [];
  let ended = false;
  const client = {
    connect: async () => {},
    query: async (sql, params) => {
      statements.push([sql, params]);
      if (sql.includes("FROM legacy_project_owner_bindings")) return { rows: [{
        legacy_project_id: "0e241789-648d-4f06-a897-6cab3ddb6e62",
        organization_id: "org", owner_user_id: "owner", operator_user_id: "owner",
        bound_at: new Date("2026-09-10T05:41:13.000Z"),
      }] };
      if (sql.includes("FROM users")) return { rows: [{ id: "owner", organization_id: "org", status: "active" }] };
      if (sql.includes("AS projects")) return { rows: [{ projects: "0", analysis_runs: "0", sync_jobs: "0", display_versions: "0" }] };
      return { rows: [] };
    },
    end: async () => { ended = true; },
  };
  const facts = await readFloorLampsCanonicalFacts(client);
  assert.equal(facts.binding.ownerUserId, "owner");
  assert.deepEqual(facts.databaseCounts, { projects: 0, analysisRuns: 0, syncJobs: 0, displayVersions: 0 });
  assert.equal(statements[0][0], "BEGIN READ ONLY");
  assert.equal(statements.at(-1)[0], "ROLLBACK");
  assert.ok(statements.every(([sql]) => !/\b(?:INSERT|UPDATE|DELETE|COMMIT)\b/i.test(sql)));
  assert.equal(ended, true);
});
