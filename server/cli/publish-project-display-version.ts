import { Pool } from "pg";

import { PostgresQueryContext } from "../db/postgres/query-context";
import { PostgresProjectDisplayVersionStore } from "../db/postgres/project-display-version-store";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const args = process.argv.slice(2);
function value(flag: string) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1] ?? null;
}
const projectId = value("--project-id"), jobId = value("--job-id");
const apply = args.includes("--apply");
if (!uuid.test(projectId ?? "") || !uuid.test(jobId ?? "") || args.some(arg => arg.startsWith("--")
  && !["--project-id", "--job-id", "--apply"].includes(arg))) {
  throw new Error("Usage: --project-id UUID --job-id UUID [--apply]");
}
if (!process.env.AGENT_DATABASE_URL) throw new Error("AGENT_DATABASE_URL is required");

const pool = new Pool({ connectionString: process.env.AGENT_DATABASE_URL, max: 1 });
const queries = new PostgresQueryContext(pool);
const store = new PostgresProjectDisplayVersionStore(queries);
const previewRollback = Symbol("preview-rollback");
let summary: Record<string, unknown> | null = null;
try {
  await queries.transaction(async () => {
    const scope = await queries.query<{ organization_id: string }>(
      "SELECT organization_id FROM projects WHERE id=$1", [projectId]);
    const organizationId = scope.rows[0]?.organization_id;
    if (!organizationId) throw new Error("Project not found");
    const current = await store.readCurrent({ organizationId, projectId: projectId! });
    const next = await store.publishFromCompletedJob({ organizationId, projectId: projectId!,
      jobId: jobId!, expectedCurrentVersionId: current?.versionId ?? null });
    summary = { applied: apply, projectId, jobId, versionId: next.versionId,
      sourceCompletedAt: next.sourceCompletedAt, contentHash: next.contentHash,
      gapCount: next.gaps.length, stageCount: Object.keys(next.stageOutputs).length };
    if (!apply) throw previewRollback;
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  if (error === previewRollback && summary) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else {
    process.stderr.write(`${error instanceof Error ? error.message : "Publication failed"}\n`);
    process.exitCode = 1;
  }
} finally {
  await queries.close();
}
