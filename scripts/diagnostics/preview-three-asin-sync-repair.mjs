// Read-only, fixed-job investigation. No apply mode, provider calls, or file writes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";
import { createBuildSourceFingerprint } from "../lib/build-fingerprint.mjs";
import { readCachedDataExport } from "../lib/sync-cache.mjs";
import { projectStageOutput } from "../lib/sync-stage-output.mjs";

const jobId = "2f37a6e3-5ef0-4561-a6dd-359096876b72";
const root = "C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/integrate-xydc-variant-20260905";
const configuration = "C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/formal-stack.env";
const restoredAsin = "B09NNDX731";
const env = Object.fromEntries(fs.readFileSync(configuration, "utf8").split(/\r?\n/)
  .filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")];
  }));
const client = new pg.Client({
  connectionString: env.AGENT_DATABASE_URL, connectionTimeoutMillis: 5_000,
  options: "-c default_transaction_read_only=on -c statement_timeout=10000",
});
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const requireMatch = condition => { if (!condition) throw new Error("Preview scope or snapshot mismatch"); };

try {
  requireMatch(process.argv.length === 2);
  const mirrorBytes = fs.readFileSync(path.join(root, "data/sync-jobs", `${jobId}.json`));
  const mirror = JSON.parse(mirrorBytes);
  requireMatch(/^[a-f0-9]{64}$/.test(mirror.publication.artifactId));
  const artifactRoot = path.join(root, "data/web-runtime-artifacts", `publication-${mirror.publication.artifactId}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, "web-artifact.json"), "utf8"));
  const fingerprint = JSON.parse(fs.readFileSync(path.join(artifactRoot, "build-fingerprint.json"), "utf8")).sourceHash;
  requireMatch(manifest.jobId === jobId && manifest.jobVersion === 11 && mirror.jobVersion === 11 &&
    manifest.artifactId === mirror.publication.artifactId && await createBuildSourceFingerprint(root) === fingerprint);

  await client.connect();
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const { rows: [job] } = await client.query(
    "SELECT job_id, job_version, status, updated_at, asins, asin_progress FROM sync_jobs WHERE job_id=$1", [jobId],
  );
  requireMatch(Number(job?.job_version) === 11 && job.status === "completed" &&
    hash([...job.asins].sort()) === hash(["B09NNDX731", "B0BHHP21DP", "B0CZRBL776"].sort()));
  const { rows: outputs } = await client.query(
    "SELECT stage_id, stage_status, content_hash, data_json, gap_json FROM sync_job_stage_outputs WHERE job_id=$1 ORDER BY stage_id", [jobId],
  );
  requireMatch(outputs.length === Object.keys(manifest.stageContentHashes).length);
  for (const row of outputs) requireMatch(manifest.stageContentHashes[row.stage_id] === row.content_hash &&
    hash({ stage: row.stage_id, ...(row.data_json ? { data: row.data_json } : {}), ...(row.gap_json ? { gap: row.gap_json } : {}) }) === row.content_hash);

  const traffic = projectStageOutput("traffic", [restoredAsin], {
    readExport: (file, name) => readCachedDataExport(path.join(root, "app", path.basename(file)), name),
  }).data;
  const listing = traffic.listingByAsin[restoredAsin];
  requireMatch(job.asin_progress[restoredAsin]?.traffic?.status === "ready" && (listing?.totalScore ?? listing?.total) > 0);
  // Reclassification is conditional on the exact provider evidence recorded in
  // docs/verification/2026-09-10-three-asin-sync-gaps.md, not a fresh provider read.
  const changes = {
    keywords: ["B0BHHP21DP", "B0CZRBL776"], reviews: ["B0CZRBL776"],
    child_sales: ["B0CZRBL776"], category: ["B0CZRBL776"],
  };
  const previews = outputs.filter(row => changes[row.stage_id] || row.stage_id === "traffic").map(row => {
    requireMatch(row.stage_status === "partial" && Array.isArray(row.gap_json?.items));
    const gap = structuredClone(row.gap_json);
    let data = structuredClone(row.data_json);
    if (row.stage_id === "traffic") {
      gap.items = gap.items.filter(item => item.asin !== restoredAsin);
      data = { ...data,
        listingByAsin: { ...data?.listingByAsin, ...traffic.listingByAsin },
        monthlyByAsin: { ...data?.monthlyByAsin, ...traffic.monthlyByAsin },
      };
    } else gap.items = gap.items.map(item => changes[row.stage_id].includes(item.asin)
      ? { asin: item.asin, causeCode: "UPSTREAM_EMPTY" } : item);
    gap.reasonCode = "UPSTREAM_EMPTY";
    return {
      stage: row.stage_id, status: row.stage_status, beforeGap: row.gap_json, previewGap: gap,
      beforeHash: row.content_hash, previewHash: hash({ stage: row.stage_id, data, gap }),
      successfulDataUnchanged: row.stage_id === "traffic" ? undefined : hash(data) === hash(row.data_json),
      restoredTraffic: row.stage_id === "traffic" ? {
        asin: restoredAsin, totalScore: listing.totalScore ?? listing.total,
        listingDigest: hash(listing), monthlyPresent: !!traffic.monthlyByAsin[restoredAsin],
      } : undefined,
    };
  });
  requireMatch(await createBuildSourceFingerprint(root) === fingerprint &&
    fs.readFileSync(path.join(root, "data/sync-jobs", `${jobId}.json`)).equals(mirrorBytes));
  const readOnly = (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only;
  requireMatch(readOnly === "on");
  await client.query("ROLLBACK");
  console.log(JSON.stringify({ jobId, version: 11, updatedAt: job.updated_at,
    artifactId: manifest.artifactId, sourceFingerprint: fingerprint,
    allPersistedStageHashesMatchArtifact: true, readOnly, previews }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ previewFailed: true, name: error.name, code: error.code }));
  process.exitCode = 1;
} finally {
  await client.end();
}
