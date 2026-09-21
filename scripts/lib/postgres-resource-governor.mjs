import { createHash, randomUUID } from "node:crypto";

import pg from "pg";

export class ResourceGovernorAdmissionError extends Error {
  constructor(options = {}) {
    super("External request capacity is temporarily unavailable");
    this.name = "ResourceGovernorAdmissionError";
    this.reason = ['rolling-window','concurrency','paused','unavailable','cancelled'].includes(options.reason) ? options.reason : 'unavailable';
    this.retryAt = this.reason === 'rolling-window' && options.retryAt && Number.isFinite(Date.parse(options.retryAt)) ? new Date(options.retryAt).toISOString() : null;
  }
}

const { Pool } = pg;
const admissionLockId = "731553996872021106";

/**
 * @template T
 * @typedef {object} ScriptGovernedRequest
 * @property {string} organizationId
 * @property {import('../../server/db/concurrency-control-repository').GovernedResource} resource
 * @property {string} jobId
 * @property {import('../../server/db/concurrency-control-repository').GovernedAttemptKind | 'transient-retry'} attemptKind
 * @property {() => Promise<T>} operation
 * @property {string} [stageId]
 * @property {string} [logicalOperationKey]
 * @property {string} [dispatchKey]
 * @property {AbortSignal} [signal]
 * @property {number} [leaseMs]
 * @property {number} [maxWaitMs]
 */

/**
 * @typedef {object} ScriptResourceGovernor
 * @property {<T>(input: ScriptGovernedRequest<T>) => Promise<T>} run
 * @property {() => Promise<void>} [close]
 */

/**
 * @param {{ databaseUrl?: string, ownerId?: string, pool?: import('pg').Pool }} [options]
 * @returns {ScriptResourceGovernor & { close: () => Promise<void> }}
 */
export function createPostgresResourceGovernor(options = {}) {
  const { databaseUrl, ownerId = `child-${process.pid}-${randomUUID()}`, pool } = options;
  const ownedPool = pool ?? (
    databaseUrl
      ? new Pool({ connectionString: databaseUrl, max: 1 })
      : null
  );
  if (!ownedPool) throw new ResourceGovernorAdmissionError();

  return {
    async run(input) {
      const governedInput = withAttemptIdentity(input);
      assertAdmissionActive(governedInput.signal);
      const permit = await acquirePermit(ownedPool, {
        ...governedInput,
        ownerId,
        leaseMs: governedInput.leaseMs ?? 120_000,
        maxWaitMs: governedInput.maxWaitMs ?? 5_000,
      });
      try {
        assertAdmissionActive(governedInput.signal);
        const receipt = await recordPhysicalAttempt(ownedPool, governedInput);
        if (governedInput.signal?.aborted) {
          await compensateUndispatchedPhysicalAttempt(ownedPool, receipt);
          throw new ResourceGovernorAdmissionError({reason:'cancelled'});
        }
        return await governedInput.operation();
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

/** @param {Readonly<Record<string, string | undefined>>} [env] */
export function createPostgresResourceGovernorFromEnv(env = process.env) {
  return createPostgresResourceGovernor({
    databaseUrl: env.AGENT_DATABASE_URL,
    ownerId: env.AGENT_RESOURCE_GOVERNOR_OWNER_ID,
  });
}

/**
 * @template T
 * @typedef {object} GovernExternalRequestOptions
 * @property {ScriptResourceGovernor} [resourceGovernor]
 * @property {(env: Readonly<Record<string, string | undefined>>) => ScriptResourceGovernor} [createResourceGovernor]
 * @property {boolean} [requireResourceGovernor]
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {string | null} [organizationId]
 * @property {string | null} [jobId]
 * @property {import('../../server/db/concurrency-control-repository').GovernedResource} resource
 * @property {import('../../server/db/concurrency-control-repository').GovernedAttemptKind | 'transient-retry'} [attemptKind]
 * @property {string} [stageId]
 * @property {string} [logicalOperationKey]
 * @property {string} [dispatchKey]
 * @property {AbortSignal} [signal]
 * @property {number} [leaseMs]
 * @property {number} [maxWaitMs]
 * @property {() => Promise<T>} operation
 */

/**
 * @template T
 * @param {GovernExternalRequestOptions<T>} options
 * @returns {Promise<T>}
 */
export async function governExternalRequest(options) {
  const {
    resourceGovernor,
    createResourceGovernor = createPostgresResourceGovernorFromEnv,
    requireResourceGovernor = false,
    env = process.env,
    organizationId = env.AGENT_EXECUTION_ORGANIZATION_ID,
    jobId = env.AGENT_SYNC_JOB_ID,
    resource,
    attemptKind = "initial",
    stageId = env.AGENT_SYNC_STAGE_ID ?? "unknown-stage",
    logicalOperationKey,
    dispatchKey,
    signal,
    leaseMs,
    maxWaitMs,
    operation,
  } = options;
  let ownsGovernor = false;
  const governor = resourceGovernor ??
    (requireResourceGovernor || env.AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED === "1"
      ? (() => {
          ownsGovernor = true;
          return createResourceGovernor(env);
        })()
      : null);
  if (!governor) return await operation();
  try {
    if (!organizationId || !jobId) throw new ResourceGovernorAdmissionError();
    return await governor.run({
      organizationId,
      resource,
      jobId,
      attemptKind,
      stageId,
      logicalOperationKey,
      dispatchKey,
      signal,
      leaseMs,
      maxWaitMs,
      operation,
    });
  } finally {
    if (ownsGovernor) await governor.close?.();
  }
}

async function acquirePermit(pool, input) {
  const deadline = Date.now() + input.maxWaitMs;
  while (true) {
    assertAdmissionActive(input.signal);
    const permit = await tryAcquirePermit(pool, input);
    if (permit) {
      if (input.signal?.aborted) {
        await releasePermit(pool, {
          permitId: permit.permitId,
          ownerId: input.ownerId,
          leaseGeneration: permit.leaseGeneration,
        }).catch(() => undefined);
        throw new ResourceGovernorAdmissionError({reason:'cancelled'});
      }
      return permit;
    }
    assertAdmissionActive(input.signal);
    if (input.maxWaitMs === 0 || Date.now() >= deadline) {
      throw new ResourceGovernorAdmissionError({reason:'concurrency'});
    }
    await delay(
      Math.min(50, Math.max(1, deadline - Date.now())),
      input.signal,
    );
  }
}

async function tryAcquirePermit(pool, input) {
  const client = await pool.connect();
  const acquiredAt = new Date().toISOString();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [admissionLockId]);
    const policy = await readPolicy(client, input.organizationId, input.jobId);
    await requireOpenCircuit(client,input);
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
         permit_id, organization_id, resource, job_id, attempt_kind, stage_id,
         logical_operation_key, dispatch_key, owner_id, lease_generation,
         policy_version, acquired_at, lease_expires_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10,
         $11, $11::timestamptz + ($12::text || ' milliseconds')::interval
       )
       RETURNING permit_id, lease_generation`,
      [
        randomUUID(),
        input.organizationId,
        input.resource,
        input.jobId,
        input.attemptKind,
        input.stageId,
        input.logicalOperationKey,
        input.dispatchKey,
        input.ownerId,
        policy.record_policy_version,
        acquiredAt,
        input.leaseMs,
      ],
    );
    await client.query("COMMIT");
    return {
      permitId: inserted.rows[0].permit_id,
      leaseGeneration: inserted.rows[0].lease_generation,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if(error instanceof ResourceGovernorAdmissionError) throw error;
    throw new ResourceGovernorAdmissionError();
  } finally {
    client.release();
  }
}

async function recordPhysicalAttempt(pool, input) {
  assertAdmissionActive(input.signal);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    assertAdmissionActive(input.signal);
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [admissionLockId]);
    assertAdmissionActive(input.signal);
    const clock = await client.query("SELECT clock_timestamp() AS admission_now");
    const recordedAt = new Date(clock.rows[0].admission_now).toISOString();
    const policy = await readPolicy(client, input.organizationId, input.jobId);
    await requireOpenCircuit(client,input);
    if (input.resource === "sellerSprite") {
      const count = await client.query(
        `WITH active AS (
             SELECT recorded_at FROM concurrency_physical_attempts
             WHERE organization_id = $1 AND resource = 'sellerSprite'
               AND recorded_at > $2::timestamptz - ($3::text || ' milliseconds')::interval
               AND recorded_at <= $2::timestamptz
           ) SELECT count(*)::integer AS count,
             (SELECT recorded_at + ($3::text || ' milliseconds')::interval FROM active
              ORDER BY recorded_at OFFSET GREATEST(0,(SELECT count(*) FROM active)-$4) LIMIT 1) AS retry_at
             FROM active`,
        [input.organizationId, recordedAt, policy.seller_sprite_rolling_window_ms, policy.seller_sprite_rolling_max_attempts],
      );
      if ((count.rows[0]?.count ?? 0) >= policy.seller_sprite_rolling_max_attempts) {
        throw new ResourceGovernorAdmissionError({reason: 'rolling-window', retryAt: new Date(count.rows[0].retry_at).toISOString()});
      }
    }
    assertAdmissionActive(input.signal);
    const inserted = await client.query(
      `INSERT INTO concurrency_physical_attempts (
         organization_id, resource, job_id, attempt_kind, stage_id,
         logical_operation_key, dispatch_key, policy_version, recorded_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.organizationId,
        input.resource,
        input.jobId,
        input.attemptKind,
        input.stageId,
        input.logicalOperationKey,
        input.dispatchKey,
        policy.record_policy_version,
        recordedAt,
      ],
    );
    assertAdmissionActive(input.signal);
    const attemptId = inserted.rows[0]?.id;
    if (attemptId === undefined) throw new ResourceGovernorAdmissionError();
    await client.query("COMMIT");
    return Object.freeze({
      attemptId: String(attemptId),
      organizationId: input.organizationId,
      resource: input.resource,
      jobId: input.jobId,
      attemptKind: input.attemptKind,
      stageId: input.stageId,
      logicalOperationKey: input.logicalOperationKey,
      dispatchKey: input.dispatchKey,
      policyVersion: policy.record_policy_version,
      recordedAt,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof ResourceGovernorAdmissionError) throw error;
    throw new ResourceGovernorAdmissionError();
  } finally {
    client.release();
  }
}

async function compensateUndispatchedPhysicalAttempt(pool, receipt) {
  try {
    const deleted = await pool.query(
      `DELETE FROM concurrency_physical_attempts
        WHERE id = $1::bigint
          AND organization_id = $2
          AND resource = $3
          AND job_id = $4
          AND attempt_kind = $5
          AND stage_id = $6
          AND logical_operation_key = $7
          AND dispatch_key = $8
          AND policy_version = $9
          AND recorded_at = $10::timestamptz`,
      [
        receipt.attemptId,
        receipt.organizationId,
        receipt.resource,
        receipt.jobId,
        receipt.attemptKind,
        receipt.stageId,
        receipt.logicalOperationKey,
        receipt.dispatchKey,
        receipt.policyVersion,
        receipt.recordedAt,
      ],
    );
    if (deleted.rowCount !== 1) throw new ResourceGovernorAdmissionError();
  } catch (error) {
    if (error instanceof ResourceGovernorAdmissionError) throw error;
    throw new ResourceGovernorAdmissionError();
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

async function readPolicy(client, organizationId, jobId) {
  const result = await client.query(
    `WITH current_policy AS (
       SELECT policy.*
       FROM concurrency_policy_current current_pointer
       JOIN concurrency_policy_versions policy
         ON policy.policy_version = current_pointer.policy_version
       WHERE current_pointer.organization_id IN ($1, '*')
       ORDER BY CASE WHEN current_pointer.organization_id = $1 THEN 0 ELSE 1 END
       LIMIT 1
     ),
     job_policy AS (
       SELECT policy.*
       FROM sync_jobs job
       JOIN concurrency_policy_versions policy
         ON policy.policy_version = job.policy_version
       WHERE job.organization_id = $1 AND job.job_id = $2
       LIMIT 1
     )
     SELECT
       COALESCE(job_policy.policy_version, current_policy.policy_version) AS record_policy_version,
       LEAST(COALESCE(job_policy.whole_job_limit, current_policy.whole_job_limit), current_policy.whole_job_limit) AS whole_job_limit,
       LEAST(COALESCE(job_policy.seller_sprite_concurrency, current_policy.seller_sprite_concurrency), current_policy.seller_sprite_concurrency) AS seller_sprite_concurrency,
       LEAST(COALESCE(job_policy.sif_concurrency, current_policy.sif_concurrency), current_policy.sif_concurrency) AS sif_concurrency,
       LEAST(COALESCE(job_policy.sorftime_concurrency, current_policy.sorftime_concurrency), current_policy.sorftime_concurrency) AS sorftime_concurrency,
       LEAST(COALESCE(job_policy.model_concurrency, current_policy.model_concurrency), current_policy.model_concurrency) AS model_concurrency,
       LEAST(COALESCE(job_policy.image_concurrency, current_policy.image_concurrency), current_policy.image_concurrency) AS image_concurrency,
       LEAST(COALESCE(job_policy.seller_sprite_rolling_max_attempts, current_policy.seller_sprite_rolling_max_attempts), current_policy.seller_sprite_rolling_max_attempts) AS seller_sprite_rolling_max_attempts,
       LEAST(COALESCE(job_policy.seller_sprite_rolling_window_ms, current_policy.seller_sprite_rolling_window_ms), current_policy.seller_sprite_rolling_window_ms) AS seller_sprite_rolling_window_ms
     FROM current_policy
     LEFT JOIN job_policy ON true`,
    [organizationId, jobId],
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

function delay(ms, signal) {
  assertAdmissionActive(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout);
      reject(new ResourceGovernorAdmissionError({reason:'cancelled'}));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function assertAdmissionActive(signal) {
  if (signal?.aborted) throw new ResourceGovernorAdmissionError({reason:'cancelled'});
}

function withAttemptIdentity(input) {
  const attemptKind = input.attemptKind ?? "initial";
  const stageId = boundedIdentity(input.stageId, 100) ?? "unknown-stage";
  const logicalOperationKey = boundedIdentity(input.logicalOperationKey, 200) ??
    `legacy:${createHash("sha256").update(JSON.stringify([
      input.organizationId,
      input.resource,
      input.jobId,
      attemptKind,
    ])).digest("hex")}`;
  const dispatchKey = boundedIdentity(input.dispatchKey, 240) ??
    `${logicalOperationKey}:${attemptKind}`;
  return {
    ...input,
    attemptKind,
    stageId,
    logicalOperationKey,
    dispatchKey,
  };
}

function boundedIdentity(value, maxLength) {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new ResourceGovernorAdmissionError();
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw new ResourceGovernorAdmissionError();
  }
  return normalized;
}

async function requireOpenCircuit(client,input) {
  if(!['sellerSprite','sif','sorftime'].includes(input.resource) || (input.resource==='sellerSprite'&&input.attemptKind==='quota-refresh'))return;
  const result=await client.query('SELECT manual_hold, auto_paused FROM concurrency_resource_circuits WHERE organization_id=$1 AND resource=$2',[input.organizationId,input.resource]);
  if(result.rows[0]?.manual_hold||result.rows[0]?.auto_paused)throw new ResourceGovernorAdmissionError({reason:'paused'});
}
