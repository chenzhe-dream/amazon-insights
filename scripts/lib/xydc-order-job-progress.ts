import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import {
  XydcOrderJobIdentitySchema, XydcOrderProgressRecordSchema, isXydcOrderProgressTerminal,
  type XydcOrderJobIdentity, type XydcOrderProgressRecord, type XydcOrderProgressView, type XydcOrderReadScope,
} from "../../shared/xydc-order-progress";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";
import { XydcProviderError } from "./xydc-provider-error";

const MAX_BYTES = 65_536;
const DAY_MS = 86_400_000;
const envelope = {
  organizationId: "AGENT_EXECUTION_ORGANIZATION_ID", projectId: "AGENT_XYDC_PROJECT_ID", runId: "AGENT_XYDC_RUN_ID",
  jobId: "AGENT_SYNC_JOB_ID", workerId: "AGENT_RESOURCE_GOVERNOR_OWNER_ID", leaseGeneration: "AGENT_XYDC_LEASE_GENERATION",
} as const;

export function parseXydcJobIdentity(env: NodeJS.ProcessEnv): XydcOrderJobIdentity | null {
  if (![...Object.values(envelope), "AGENT_XYDC_PARENT_IPC"].some(key => env[key] !== undefined)) return null;
  const parsed = XydcOrderJobIdentitySchema.safeParse(Object.fromEntries(Object.entries(envelope).map(([key, name]) => [
    key, key === "leaseGeneration" && /^\d+$/.test(env[name] ?? "") ? Number(env[name]) : env[name],
  ])));
  if (!parsed.success) throw new Error("XYDC_JOB_CONTEXT_INVALID");
  return parsed.data;
}

const JobSchema = z.object({
  jobId: z.string(), organizationId: z.string(), projectId: z.string(), runId: z.string(), country: z.string(),
  asins: z.array(z.string()), state: z.enum(["queued", "running", "completed", "failed"]), workerId: z.string().nullable(),
  leaseGeneration: z.number().int().nonnegative(), leaseValid: z.boolean(), runState: z.string(),
  stages: z.array(z.object({
    id: z.string(),
    repairParentJobId: z.string().trim().min(1).optional(),
    repairXydcAsins: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).optional(),
  })).optional(),
});
type Job = z.infer<typeof JobSchema>;
function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && new Set(left).size === left.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
export function createXydcJobAuthority(pool: Pick<Pool, "query">) {
  async function read(scope: XydcOrderReadScope, jobId?: string): Promise<Job | null> {
    if (!scope.currentRunId) return null;
    const query = {
      text: `SELECT job.job_id AS "jobId", job.organization_id AS "organizationId", job.project_id AS "projectId",
        job.run_id AS "runId", job.marketplace AS country, job.asins, job.stages, job.status AS state,
        job.leased_by AS "workerId", job.lease_generation AS "leaseGeneration",
        COALESCE(job.lease_expires_at > clock_timestamp(), false) AS "leaseValid", run.status AS "runState"
        FROM sync_jobs job JOIN analysis_runs run ON run.id=job.run_id AND run.project_id=job.project_id
        WHERE job.organization_id=$1 AND job.project_id=$2 AND job.run_id=$3 AND ($4::text IS NULL OR job.job_id=$4)
        ORDER BY job.created_at DESC, job.job_id DESC LIMIT 1`,
      values: [scope.organizationId, scope.projectId, scope.currentRunId, jobId ?? null], query_timeout: 1_000,
    };
    const result = await pool.query(query);
    const parsed = JobSchema.safeParse(result.rows[0]);
    return parsed.success && parsed.data.country === scope.country && sameSet(parsed.data.asins, scope.asins) ? parsed.data : null;
  }
  return {
    read,
    async assert(identity: XydcOrderJobIdentity, scope: XydcOrderReadScope, signal: AbortSignal) {
      signal.throwIfAborted();
      const job = await read(scope, identity.jobId);
      signal.throwIfAborted();
      if (!job || job.organizationId !== identity.organizationId || job.projectId !== identity.projectId || job.runId !== identity.runId
        || job.leaseGeneration !== identity.leaseGeneration || job.workerId !== identity.workerId || job.state !== "running"
        || !job.leaseValid || job.runState === "cancelled") throw new XydcProviderError("CANCELLED");
    },
  };
}
export type XydcJobAuthority = ReturnType<typeof createXydcJobAuthority>;

export function createXydcProgressPool(env: NodeJS.ProcessEnv) {
  if (!env.AGENT_DATABASE_URL?.trim()) throw new Error("XYDC_JOB_DATABASE_NOT_CONFIGURED");
  return new Pool({ connectionString: env.AGENT_DATABASE_URL, max: 2, connectionTimeoutMillis: 1_000,
    query_timeout: 1_000, statement_timeout: 1_000, idleTimeoutMillis: 1_000, allowExitOnIdle: true });
}

function progressDirectory(runtimeRoot: string) {
  if (!path.isAbsolute(runtimeRoot)) throw new Error("XYDC_RUNTIME_ROOT_INVALID");
  return path.join(runtimeRoot, "xydc-order-progress", "v1");
}
export function xydcOrderProgressPath(runtimeRoot: string, identity: Pick<XydcOrderJobIdentity, "jobId" | "leaseGeneration">) {
  const key = createHash("sha256").update(`${identity.jobId}:${identity.leaseGeneration}`).digest("hex");
  return path.join(progressDirectory(runtimeRoot), `${key}.json`);
}
function readRecord(file: string): XydcOrderProgressRecord | null {
  let descriptor: number | undefined;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    descriptor = fs.openSync(file, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > MAX_BYTES) return null;
    const parsed = XydcOrderProgressRecordSchema.safeParse(JSON.parse(buffer.subarray(0, bytes).toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export async function writeXydcOrderProgress(
  runtimeRoot: string, record: XydcOrderProgressRecord, authorize: () => Promise<void>, signal: AbortSignal,
) {
  const validated = XydcOrderProgressRecordSchema.parse(record);
  const body = JSON.stringify(validated);
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("XYDC_PROGRESS_TOO_LARGE");
  signal.throwIfAborted();
  await authorize();
  signal.throwIfAborted();
  const file = xydcOrderProgressPath(runtimeRoot, validated);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    // Fresh authority follows preparation; the final signal check and rename have no async gap.
    await authorize();
    signal.throwIfAborted();
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

export function cleanupXydcOrderProgress(runtimeRoot: string, now = Date.now()) {
  const directory = progressDirectory(runtimeRoot);
  let names: string[];
  try { names = fs.readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    const record = readRecord(file);
    if (record && file === xydcOrderProgressPath(runtimeRoot, record) && isXydcOrderProgressTerminal(record.state)
      && now - Date.parse(record.updatedAt) > DAY_MS) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

function familyScope(families: readonly XydcVariantFamily[], scope: XydcOrderReadScope) {
  const grouped = new Map<string, Set<string>>();
  for (const family of families) {
    if (!scope.asins.includes(family.inputAsin) || family.country !== scope.country || family.cacheState !== "fresh"
      || family.status === "unavailable" || !family.children.length) continue;
    const children = grouped.get(family.parentAsin) ?? new Set<string>();
    family.children.forEach(child => children.add(child.asin));
    grouped.set(family.parentAsin, children);
  }
  return [...grouped].map(([parentAsin, children]) => ({ parentAsin, childAsins: [...children].sort() })).sort((a, b) => a.parentAsin.localeCompare(b.parentAsin));
}

export async function readXydcOrderProgress(
  runtimeRoot: string, scope: XydcOrderReadScope, families: readonly XydcVariantFamily[], authority: XydcJobAuthority, now = new Date(),
): Promise<XydcOrderProgressView | null> {
  if (!scope.currentRunId) return null;
  let job: Job | null;
  try { job = await authority.read(scope); } catch { return null; }
  if (!job) return null;
  const activeJob = job.runState !== "cancelled" && (job.state === "queued" || (job.state === "running" && job.leaseValid && job.workerId !== null));
  const view: XydcOrderProgressView = { currentRunId: scope.currentRunId, jobId: job.jobId, leaseGeneration: job.leaseGeneration, activeJob, progress: null };
  const record = readRecord(xydcOrderProgressPath(runtimeRoot, job));
  if (!record || record.organizationId !== scope.organizationId || record.projectId !== scope.projectId || record.runId !== scope.currentRunId
    || record.jobId !== job.jobId || record.leaseGeneration !== job.leaseGeneration || record.country !== scope.country
    || JSON.stringify(record.window) !== JSON.stringify(getXydcOrderWindow(now))
    || Date.parse(record.updatedAt) > now.getTime()
    || (isXydcOrderProgressTerminal(record.state) && now.getTime() - Date.parse(record.updatedAt) > DAY_MS)) return view;
  // Only authoritative persisted repair metadata can narrow displayed family progress.
  // The job/lease authority above still validates the entire original ASIN scope.
  const repairStages = job.stages?.filter(stage => stage.id === "catalog" && stage.repairXydcAsins !== undefined) ?? [];
  let progressScope = scope;
  if (repairStages.length) {
    const repair = repairStages[0]!;
    const targets = repair.repairXydcAsins!;
    if (repairStages.length !== 1 || !repair.repairParentJobId || new Set(targets).size !== targets.length
      || targets.some(asin => !scope.asins.includes(asin))) return view;
    progressScope = { ...scope, asins: targets };
  }
  const expected = familyScope(families, progressScope);
  const actual = record.families.map(family => ({ ...family, childAsins: [...family.childAsins].sort() })).sort((a, b) => a.parentAsin.localeCompare(b.parentAsin));
  if (!expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) return view;
  let state = record.state;
  if (job.runState === "cancelled") state = "cancelled";
  else if (job.state === "failed") state = "failed";
  else if (!(job.state === "completed" && ["completed", "partial"].includes(state))
    && (!activeJob || job.workerId !== record.workerId
      || (!isXydcOrderProgressTerminal(state) && now.getTime() - Date.parse(record.updatedAt) > 45_000))) state = "interrupted";
  view.progress = { state, ready: record.children.filter(child => child.state === "ready" || child.state === "cached").length,
    cached: record.children.filter(child => child.state === "cached").length, total: record.children.length,
    updatedAt: record.updatedAt, retryAt: state === "rate-wait" ? record.retryAt : null, safeReason: record.safeReason };
  return view;
}
