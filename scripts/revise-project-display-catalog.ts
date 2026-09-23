import path from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { PostgresProjectDisplayVersionStore } from "../server/db/postgres/project-display-version-store";
import { PostgresQueryContext } from "../server/db/postgres/query-context";
import { captureGeneratedSyncCatalog } from "../server/services/sync-catalog-capture";

function argumentsFrom(argv: readonly string[]) {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--apply") { apply = true; continue; }
    if (!option?.startsWith("--") || !["--organization-id", "--project-id", "--expected-version-id",
      "--catalog-path", "--source-job-id", "--expected-source-sha256"].includes(option) || !argv[index + 1]) {
      throw new Error(`Unknown or incomplete option: ${option}`);
    }
    values.set(option, argv[++index]!);
  }
  for (const required of ["--organization-id", "--project-id", "--expected-version-id", "--catalog-path", "--source-job-id"]) {
    if (!values.get(required)) throw new Error(`Missing ${required}`);
  }
  if (apply && !/^[a-f0-9]{64}$/.test(values.get("--expected-source-sha256") ?? "")) {
    throw new Error("--apply requires --expected-source-sha256 from a reviewed dry run");
  }
  return { apply, organizationId: values.get("--organization-id")!, projectId: values.get("--project-id")!,
    expectedVersionId: values.get("--expected-version-id")!, catalogPath: path.resolve(values.get("--catalog-path")!),
    sourceJobId: values.get("--source-job-id")!, expectedSourceSha256: values.get("--expected-source-sha256") };
}

export async function reviseProjectDisplayCatalog(argv: readonly string[], environment: Readonly<Record<string, string | undefined>> = process.env, existingPool?: Pool) {
  const input = argumentsFrom(argv);
  if (!environment.AGENT_DATABASE_URL && !existingPool) throw new Error("AGENT_DATABASE_URL is required");
  const pool = existingPool ?? new Pool({ connectionString: environment.AGENT_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const store = new PostgresProjectDisplayVersionStore(new PostgresQueryContext(pool));
    const current = await store.readCurrent({ organizationId: input.organizationId, projectId: input.projectId });
    if (!current || current.versionId !== input.expectedVersionId) throw new Error("Current display version does not match --expected-version-id");
    const capture = await captureGeneratedSyncCatalog({ catalogPath: input.catalogPath,
      asins: current.asins, capturedAt: new Date().toISOString() });
    if (input.expectedSourceSha256 && capture.evidence.sourceSha256 !== input.expectedSourceSha256) {
      throw new Error("Catalog file SHA256 changed since the reviewed preview");
    }
    const source = (await pool.query<{ organization_id: string; project_id: string; marketplace: string;
      asins: unknown; status: string; created_at: Date; completed_at: Date | null }>(`SELECT organization_id,project_id,marketplace,asins,status,created_at,completed_at
      FROM sync_jobs WHERE job_id=$1`, [input.sourceJobId])).rows[0];
    const sourceTime = Date.parse(capture.evidence.sourceUpdatedAt);
    if (!source || source.organization_id !== input.organizationId || source.project_id !== input.projectId ||
        source.marketplace !== current.marketplace || source.status !== "completed" || !source.completed_at ||
        !Array.isArray(source.asins) || source.asins.length !== current.asins.length ||
        !current.asins.every(asin => source.asins instanceof Array && source.asins.includes(asin)) ||
        sourceTime < source.created_at.getTime() - 60_000 || sourceTime > source.completed_at.getTime() + 60_000) {
      throw new Error("Catalog source job scope or file time does not match");
    }
    const evidence = { ...capture.evidence, sourceJobId: input.sourceJobId };
    const counts = { sellerSpriteSynced: capture.catalog.filter(item => item.catalogSource === "sellerSprite" && item.synced === true).length,
      unverified: capture.catalog.filter(item => item.catalogSource !== "sellerSprite" || item.synced !== true).length,
      absent: current.asins.length - capture.catalog.length };
    const preview = { mode: input.apply ? "applied" : "dry-run", projectId: input.projectId,
      expectedVersionId: input.expectedVersionId, currentJobId: current.jobId, sourceJobId: input.sourceJobId,
      sourceUpdatedAt: evidence.sourceUpdatedAt, sourceSha256: evidence.sourceSha256,
      catalogAsins: capture.catalog.map(item => item.asin), counts };
    if (!input.apply) return preview;
    const revised = await store.reviseCurrentCatalog({ organizationId: input.organizationId,
      projectId: input.projectId, expectedCurrentVersionId: input.expectedVersionId,
      catalog: capture.catalog, evidence });
    return { ...preview, versionId: revised.versionId, contentHash: revised.contentHash,
      gaps: revised.gaps.filter(gap => gap.field.startsWith("catalog")) };
  } finally {
    if (!existingPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  reviseProjectDisplayCatalog(process.argv.slice(2))
    .then(result => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); })
    .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
