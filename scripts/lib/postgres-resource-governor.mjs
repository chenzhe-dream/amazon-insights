import { randomUUID } from "node:crypto";

import pg from "pg";

export class ResourceGovernorAdmissionError extends Error {
  constructor() {
    super("External request capacity is temporarily unavailable");
    this.name = "ResourceGovernorAdmissionError";
  }
}

const { Pool } = pg;
const admissionLockId = "731553996872021106";

export function createPostgresResourceGovernor({
  databaseUrl,
  ownerId = `child-${process.pid}-${randomUUID()}`,
  pool,
} = {}) {
  const ownedPool = pool ?? (
    databaseUrl
      ? new Pool({ connectionString: databaseUrl, max: 1 })
      : null
  );
  if (!ownedPool) throw new ResourceGovernorAdmissionError();

  return {
    async run(input) {
      const permit = await acquirePermit(ownedPool, {
        ...input,
        ownerId,
        leaseMs: input.leaseMs ?? 120_000,
        maxWaitMs: input.maxWaitMs ?? 5_000,
      });
      try {
        await recordPhysicalAttempt(ownedPool, input);
        return await input.operation();
      } finally {
        await releasePermit(ownedPool, {
          permitId: permit.permitId,
          ownerId,
          leaseGeneration: permit.leaseGeneration,
        }).catch(() => undefined);
      }
    },
    async close() {
      if (!pool) await ownedPool.end();
    },
  };
}

export function createPostgresResourceGovernorFromEnv(env = process.env) {
  return createPostgresResourceGovernor({
    databaseUrl: env.AGENT_DATABASE_URL,
    ownerId: env.AGENT_RESOURCE_GOVERNOR_OWNER_ID,
  });
}

export async function governExternalRequest({
  resourceGovernor,
  requireResourceGovernor = false,
  env = process.env,
  organizationId = env.AGENT_EXECUTION_ORGANIZATION_ID,
  jobId = env.AGENT_SYNC_JOB_ID,
  resource,
  attemptKind = "initial",
  operation,
}) {
  const governor = resourceGovernor ??
    (requireResourceGovernor || env.AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED === "1"
      ? createPostgresResourceGovernorFromEnv(env)
      : null);
  if (!governor) return await operation();
  if (!organizationId || !jobId) throw new ResourceGovernorAdmissionError();
  return await governor.run({
    organizationId,
    resource,
    jobId,
    attemptKind,
    operation,
  });
}

async function acquirePermit(pool, input) {
  const deadline = Date.now() + input.maxWaitMs;
  while (true) {
    const permit = await tryAcquirePermit(pool, input);
    if (permit) return permit;
    if (input.maxWaitMs === 0 || Date.now() >= deadline) {
      throw new ResourceGovernorAdmissionError();
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

async function tryAcquirePermit(pool, input) {
  const client = await pool.connect();
  const acquiredAt = new Date().toISOString();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [admissionLockId]);
    const policy = await readPolicy(client, input.organizationId);
    const active = await client.query(
      `SELECT count(*)::integer AS count
       FROM concurrency_resource_permits
       WHERE organization_id = $1
         AND resource = $2
         AND released_at IS NULL
         AND lease_expires_at > $3::timestamptz`,
      [input.organizationId, input.resource, acquiredAt],
    );
    if ((active.rows[0]?.count ?? 0) >= limitFor(policy, input.resource)) {
      await client.query("COMMIT");
      return null;
    }
    const inserted = await client.query(
      `INSERT INTO concurrency_resource_permits (
         permit_id, organization_id, resource, job_id, attempt_kind, owner_id,
         lease_generation, policy_version, acquired_at, lease_expires_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, 1, $7,
         $8, $8::timestamptz + ($9::text || ' milliseconds')::interval
       )
       RETURNING permit_id, lease_generation`,
      [
        randomUUID(),
        input.organizationId,
        input.resource,
        input.jobId,
        input.attemptKind,
        input.ownerId,
        policy.policy_version,
        acquiredAt,
        input.leaseMs,
      ],
    );
    await client.query("COMMIT");
    return {
      permitId: inserted.rows[0].permit_id,
      leaseGeneration: inserted.rows[0].lease_generation,
    };
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new ResourceGovernorAdmissionError();
  } finally {
    client.release();
  }
}

async function recordPhysicalAttempt(pool, input) {
  const client = await pool.connect();
  const recordedAt = new Date().toISOString();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [admissionLockId]);
    const policy = await readPolicy(client, input.organizationId);
    if (input.resource === "sellerSprite") {
      const count = await client.query(
        `SELECT count(*)::integer AS count
         FROM concurrency_physical_attempts
         WHERE organization_id = $1
           AND resource = 'sellerSprite'
           AND recorded_at > $2::timestamptz - ($3::text || ' milliseconds')::interval
           AND recorded_at <= $2::timestamptz`,
        [input.organizationId, recordedAt, policy.seller_sprite_rolling_window_ms],
      );
      if ((count.rows[0]?.count ?? 0) >= policy.seller_sprite_rolling_max_attempts) {
        throw new ResourceGovernorAdmissionError();
      }
    }
    await client.query(
      `INSERT INTO concurrency_physical_attempts (
         organization_id, resource, job_id, attempt_kind, policy_version, recorded_at
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.organizationId,
        input.resource,
        input.jobId,
        input.attemptKind,
        policy.policy_version,
        recordedAt,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof ResourceGovernorAdmissionError) throw error;
    throw new ResourceGovernorAdmissionError();
  } finally {
    client.release();
  }
}

async function releasePermit(pool, input) {
  await pool.query(
    `UPDATE concurrency_resource_permits
     SET released_at = CURRENT_TIMESTAMP
     WHERE permit_id = $1
       AND owner_id = $2
       AND lease_generation = $3
       AND released_at IS NULL
       AND lease_expires_at > CURRENT_TIMESTAMP`,
    [input.permitId, input.ownerId, input.leaseGeneration],
  );
}

async function readPolicy(client, organizationId) {
  const result = await client.query(
    `SELECT policy.*
     FROM concurrency_policy_current current_policy
     JOIN concurrency_policy_versions policy
       ON policy.policy_version = current_policy.policy_version
     WHERE current_policy.organization_id IN ($1, '*')
     ORDER BY CASE WHEN current_policy.organization_id = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [organizationId],
  );
  if (!result.rows[0]) throw new ResourceGovernorAdmissionError();
  return result.rows[0];
}

function limitFor(policy, resource) {
  switch (resource) {
    case "wholeJob":
      return policy.whole_job_limit;
    case "sellerSprite":
      return policy.seller_sprite_concurrency;
    case "sif":
      return policy.sif_concurrency;
    case "sorftime":
      return policy.sorftime_concurrency;
    case "model":
      return policy.model_concurrency;
    case "image":
      return policy.image_concurrency;
    default:
      throw new ResourceGovernorAdmissionError();
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
