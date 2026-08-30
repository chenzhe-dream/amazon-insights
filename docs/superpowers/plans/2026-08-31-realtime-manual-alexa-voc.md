# Realtime Manual Alexa VOC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PostgreSQL the tenant-scoped runtime authority for Manual Alexa VOC so a successful import appears immediately in the VOC matrix and every new run snapshots the exact revision visible at one database cutoff, without restarting services or publishing tenant data into a browser bundle.

**Architecture:** Browser requests remain same-origin and are proxied through `createAgentServiceClient` to authenticated 31901 endpoints. 31901 parses, encrypts, revisions, reads, snapshots, and publishes Manual VOC through repository interfaces implemented by both SQLite and PostgreSQL; the UI owns only an epoch-scoped overlay hydrated from those endpoints. Static TypeScript data becomes a server-only, owner-gated stale migration fallback, while a DB outbox drives optional per-owner server projections outside the Web build tree.

**Tech Stack:** TypeScript 5.9, Node.js 22, React 19, Vinext/Next route handlers, Fastify 5, Zod 4, SQLite `node:sqlite`, PostgreSQL via `pg` 8.23, AES-256-GCM via `node:crypto`, Node test runner through `tsx`.

## Global Constraints

- This plan implements only subproject 1, “PostgreSQL Manual Alexa VOC authority”; comparison draft management and SIF keyword fallback require their own later plans.
- Add forward-only SQLite and PostgreSQL migrations; do not edit, delete, or renumber an existing migration and do not delete historical project, run, snapshot, report, or Manual VOC revision data.
- Initial marketplace allowlist is exactly `US`; adding a marketplace requires a later migration and contract change.
- PostgreSQL is the production authority. SQLite is a contract-compatible test/local backend, not a second production authority.
- Every runtime read, write, cache key, advisory lock, selector, audit row, outbox row, and projection is scoped by `organizationId + marketplace + asin`; no repository method may query Manual VOC by ASIN alone.
- `created_by` must resolve to an active `users` row in the same organization. The current schema has no `organizations` table, so do not invent an organization foreign key.
- `captured_at`, run `dataCutoffAt`, revision selection, run, stages, snapshot, and first job are committed from one DB transaction and one DB clock; browsers cannot submit `dataCutoffAt`.
- Revision and generation values cross JavaScript/API boundaries as decimal strings, never as JavaScript numbers.
- Raw reports are limited to 131072 UTF-8 bytes, are encrypted before persistence with `AES-256-GCM/v1`, are never logged or returned, and receive no plaintext fallback when the keyring is missing.
- Tenant Manual VOC and keyword evidence must not enter a shared client JavaScript bundle. `app/rufus-voc-data.ts` and `app/sif-keyword-analysis-data.ts` may only be server-side migration/diagnostic inputs.
- Legacy fallback is evaluated by 31901 only after a tenant SQL query succeeds with zero rows and `LegacyVocReadEligibilityGate` accepts the immutable owner manifest. DB, schema, permission, timeout, or deserialize failures fail closed.
- Publication is best-effort after the authoritative transaction. Failure cannot undo a revision, delay overlay visibility, trigger a Web reload, or make an import response fail.
- New reads and writes start behind independent feature flags. Rollback may disable UI hydration, dynamic run reads, or publication, but cannot return to a successful static-only write.
- Implementation and verification must not start a second Web server, listen on port 3000, replace running 31901/58258 services, stage generated data, or include the user's current worktree WIP.

---

## File and responsibility map

### New focused files

- `server/db/manual-alexa-voc-repository.ts`: repository records, typed failure classes, Manual VOC read/write/outbox/audit/idempotency interfaces, and decimal-revision helpers.
- `server/db/postgres/manual-alexa-voc-store.ts`: PostgreSQL SQL, stable advisory locks, DB clock, revisions/heads/outbox, cutoff reads, and run-create idempotency claims.
- `server/security/manual-alexa-voc-cipher.ts`: versioned keyring parsing, DEK wrapping, AES-GCM envelope encryption/decryption/rewrap, and zeroization.
- `server/services/manual-alexa-voc-service.ts`: pure report normalization plus authorized import/list orchestration and error mapping.
- `server/routes/manual-alexa-voc.ts`: authenticated `POST/GET /v1/manual-alexa-voc` handlers.
- `server/data/legacy-manual-alexa-voc-source.ts`: server-only owner manifest loader and `LegacyVocReadEligibilityGate`.
- `server/data/manual-alexa-voc-projection-store.ts`: atomic owner-partitioned projection/manifest file writes outside the Web build tree.
- `server/services/manual-alexa-voc-publication-service.ts`: outbox lease/dispatch/reconcile loop and health counters.
- `server/services/manual-alexa-voc-retention-service.ts`: 365-day-or-longer encrypted raw-report retention and audit sweep.
- `server/cli/bind-legacy-manual-alexa-voc.ts`: one-time audited binding of unowned legacy data to the configured default organization.
- `server/cli/rewrap-manual-alexa-voc-keys.ts`: audited KEK rotation that rewraps DEKs without changing content.
- `app/voc-display-schema.ts`: public seven-dimension labels, format hints, prompt, and workflow only; it contains no ASIN record.
- `app/manual-alexa-voc-store.ts`: pure scoped overlay reducer, epoch rules, response acceptance, and `effectiveVocByAsin` selector.
- `app/use-manual-alexa-voc.ts`: authenticated GET hydration, abort handling, focus refresh, and POST confirmation hook.
- `app/api/alexa-voc/route.ts`: same-origin bounded GET proxy.
- `tests/agent/manual-alexa-voc-*.test.ts`: contract, cipher, repository, service, route, run, legacy, publication, and client-store tests.
- `tests/manual-alexa-voc-client-bundle.test.mjs`: built-client manifest and sentinel leak scan.
- `docs/superpowers/runbooks/realtime-manual-alexa-voc-rollout.md`: flags, migration, observation, and rollback commands.

### Existing files changed in place

- `shared/agent-contracts.ts`: strict Manual VOC request/response schemas, session opaque identity, and removal of client-supplied run cutoff.
- `server/db/migrations/0019_manual_alexa_voc.sql` and `server/db/migrations/postgres/0019_manual_alexa_voc.sql`: forward schema.
- `server/db/repository.ts`, `server/db/sqlite-repository.ts`, `server/db/postgres-repository.ts`: expose and implement new repository contracts.
- `server/services/analysis-run-service.ts`, `server/services/voc-data-snapshot-service.ts`: atomic run-create replay/cutoff/snapshot path.
- `server/data/repository-voc-source.ts`: asynchronous PostgreSQL-first Manual VOC source and server-only fallback.
- `server/routes/analysis-runs.ts`, `server/app.ts`, `server/agent-service.ts`, `server/config.ts`: wire routes, strict run request, keyring/flags, and publication runtime.
- `server/routes/auth.ts`, `app/lib/web-auth-session.ts`, `app/auth-session-gate.tsx`: pass an opaque session identity used only to advance client epoch.
- `app/lib/agent-service-client.ts`, `app/api/alexa-voc/import/route.ts`: trusted proxy paths; remove worktree write/rebuild behavior.
- `app/alexa-voc-import-panel.tsx`, `app/page.tsx`, `app/voc-development-summary.ts`: consume one authenticated effective selector and remove tenant-data imports.
- `scripts/lib/alexa-voc-pipeline.mjs`: retain legacy CLI exports but delegate parsing to a side-effect-free module; it no longer participates in the Web route.
- `tests/agent/analysis-run-lifecycle.test.ts`, `tests/agent/voc-data-source.test.ts`, `tests/agent/alexa-voc-mutation-routes.test.ts`, `tests/agent/auth-routes.test.ts`, `tests/agent/web-auth-session.test.ts`, `tests/agent/sqlite-migrations.test.ts`, PostgreSQL migration/store tests: regression coverage.

## Canonical interfaces used by every task

Define these names once in `server/db/manual-alexa-voc-repository.ts`; later tasks must import them rather than restating structural lookalikes:

```ts
export type ManualAlexaVocMarketplace = "US";
export type ManualAlexaVocScope = Readonly<{
  organizationId: string;
  marketplace: ManualAlexaVocMarketplace;
  asin: string;
}>;
export type ManualAlexaVocNormalizedRecord = Readonly<{
  asin: string;
  attention: readonly string[];
  positives: readonly string[];
  negatives: readonly string[];
  unmet: readonly string[];
  audiences: readonly string[];
  scenarios: readonly string[];
  motives: readonly string[];
  captureStatus: "dialog";
}>;
export type ManualAlexaVocRevision = ManualAlexaVocScope & Readonly<{
  revision: string;
  contentHash: string;
  capturedAt: string;
  normalizedRecord: ManualAlexaVocNormalizedRecord;
  normalizedSchemaVersion: "alexa-voc-record/v2";
  parserVersion: "deterministic-alexa-parser/v3";
}>;
export type ManualAlexaVocEncryptedRaw = Readonly<{
  algVersion: "AES-256-GCM/v1";
  keyId: string;
  wrappedDek: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
  aadSha256: string;
  plaintextBytes: number;
  plaintextSha256: string;
}>;
export type PutManualAlexaVocInput = ManualAlexaVocScope & Readonly<{
  createdBy: string;
  expectedRevision: string;
  normalizedRecord: ManualAlexaVocNormalizedRecord;
  normalizedSchemaVersion: "alexa-voc-record/v2";
  parserVersion: "deterministic-alexa-parser/v3";
  contentHash: string;
  raw: ManualAlexaVocEncryptedRaw;
}>;
export type ManualAlexaVocWriteResult = Readonly<{
  record: ManualAlexaVocRevision;
  idempotent: boolean;
  publication: Readonly<{
    status: "pending" | "deduplicated" | "disabled";
    generation: string | null;
  }>;
}>;
export type RunCreationClaimInput = Readonly<{
  organizationId: string;
  idempotencyKey: string;
  fingerprint: string;
}>;
export type RunCreationClaim =
  | Readonly<{ kind: "winner" }>
  | Readonly<{ kind: "replay"; runId: string; snapshotId: string }>
  | Readonly<{ kind: "conflict"; code: "IDEMPOTENCY_KEY_REUSED" }>;
export class IdempotencyKeyReusedError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";
  constructor() { super("Idempotency-Key was already used for a different run request"); this.name = "IdempotencyKeyReusedError"; }
}
export type RunCreationCompleteInput = RunCreationClaimInput & Readonly<{
  runId: string;
  snapshotId: string;
  completedAt: string;
}>;
export type ManualAlexaVocOutboxLease = Readonly<{
  organizationId: string; marketplace: "US"; asin: string;
  revision: string; contentHash: string; generation: string;
  leaseOwner: string; leaseExpiresAt: string;
}>;
export interface ManualAlexaVocRepository {
  put(input: PutManualAlexaVocInput): Promise<ManualAlexaVocWriteResult>;
  getCurrent(input: ManualAlexaVocScope): Promise<ManualAlexaVocRevision | null>;
  listCurrent(input: Readonly<{ organizationId: string; marketplace: "US"; asins: readonly string[] }>): Promise<readonly ManualAlexaVocRevision[]>;
  listAtCutoff(input: Readonly<{ organizationId: string; marketplace: "US"; asins: readonly string[]; dataCutoffAt: string }>): Promise<readonly ManualAlexaVocRevision[]>;
  lockScopes(input: Readonly<{ organizationId: string; marketplace: "US"; asins: readonly string[] }>): Promise<void>;
  peekNextRevision(input: ManualAlexaVocScope): Promise<string>;
  readDatabaseClock(): Promise<string>;
  claimRunCreation(input: RunCreationClaimInput): Promise<RunCreationClaim>;
  completeRunCreation(input: RunCreationCompleteInput): Promise<void>;
  leasePublication(input: Readonly<{ ownerId: string; leasedAt: string; leaseDurationMs: number }>): Promise<ManualAlexaVocOutboxLease | null>;
  markPublicationApplied(input: ManualAlexaVocOutboxLease & Readonly<{ appliedAt: string }>): Promise<void>;
  markPublicationFailed(input: ManualAlexaVocOutboxLease & Readonly<{ failedAt: string; nextAttemptAt: string; errorCode: string }>): Promise<void>;
  reconcilePublication(input: Readonly<{ reconciledAt: string }>): Promise<number>;
  recordRawAccess(input: Readonly<{ id: string; organizationId: string; marketplace: "US"; asin: string; revision: string; actorUserId: string; purpose: "decrypt" | "reparse" | "export" | "key-rewrap"; occurredAt: string; result: "succeeded" | "denied" | "failed" }>): Promise<void>;
  clearExpiredRaw(input: Readonly<{ organizationId: string; before: string; clearedAt: string; actorUserId: string }>): Promise<number>;
}
```

The service entry point is exact:

```ts
createRunWithVocSnapshot(input: {
  principal: Extract<RequestPrincipal, { kind: "user" }>;
  projectId: string;
  mode: "existing-data" | "collect-missing";
  idempotencyKey: string;
}): Promise<{ run: AnalysisRun; snapshot: DataSnapshot }>;
```

The source reader becomes exact and asynchronous:

```ts
read(input: RepositoryVocReadInput): Promise<RepositoryVocReadResult>;
// RepositoryVocReadInput adds organizationId: string and keeps marketplace,
// asins, dataCutoffAt. Callers must await it.
```

### Task 1: Freeze strict public contracts and the opaque session identity

**Files:**
- Modify: `shared/agent-contracts.ts:1-1018,1310-1490`
- Modify: `server/routes/auth.ts:159-180`
- Modify: `app/lib/web-auth-session.ts:1-100`
- Modify: `app/auth-session-gate.tsx:10-18,188-240`
- Test: `tests/agent/contracts.test.ts`
- Test: `tests/agent/auth-routes.test.ts`
- Test: `tests/agent/web-auth-session.test.ts`

**Interfaces:**
- Consumes: existing `strictObject`, `UserSchema`, `MarketplaceSchema`, `AsinSchema`, `DateTimeSchema`, `Sha256Schema`, and authenticated principal `sessionId`.
- Produces: `ManualAlexaVocImportRequest`, `ManualAlexaVocWriteResponse`, `ManualAlexaVocListQuery`, `ManualAlexaVocListResponse`; `SessionResponse.sessionIdentity`; strict `CreateRunRequest` without `dataCutoffAt`.

- [ ] **Step 1: Add failing contract tests for strict import/list shapes and string bigint fields**

```ts
assert.equal(ManualAlexaVocImportRequestSchema.safeParse({ asin: ASIN, marketplace: "US", rawText: REPORT }).success, true);
assert.equal(ManualAlexaVocImportRequestSchema.safeParse({ asin: ASIN, marketplace: "US", text: REPORT }).success, true);
assert.equal(ManualAlexaVocImportRequestSchema.safeParse({ asin: ASIN, marketplace: "US", text: REPORT, rawText: REPORT }).success, false);
assert.equal(ManualAlexaVocImportRequestSchema.safeParse({ asin: ASIN, marketplace: "CA", rawText: REPORT }).success, false);
assert.equal(ManualAlexaVocRecordSchema.safeParse({ ...record, revision: 4 }).success, false);
assert.equal(CreateRunRequestSchema.safeParse({ mode: "existing-data", idempotencyKey: "k", dataCutoffAt: NOW }).success, false);
```

- [ ] **Step 2: Run the contract tests and confirm RED**

Run: `npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/auth-routes.test.ts tests/agent/web-auth-session.test.ts`

Expected: FAIL because the Manual VOC exports and `sessionIdentity` do not exist and `CreateRunRequestSchema` still accepts `dataCutoffAt`.

- [ ] **Step 3: Add strict schemas and normalize compatibility fields at the boundary**

```ts
const NonEmptyTextSchema = z.string().trim().min(1).max(16_384);
export const ManualAlexaVocNormalizedRecordSchema = strictObject({
  asin: AsinSchema,
  attention: z.array(NonEmptyTextSchema).min(1), positives: z.array(NonEmptyTextSchema).min(1),
  negatives: z.array(NonEmptyTextSchema).min(1), unmet: z.array(NonEmptyTextSchema).min(1),
  audiences: z.array(NonEmptyTextSchema).min(1), scenarios: z.array(NonEmptyTextSchema).min(1),
  motives: z.array(NonEmptyTextSchema).min(1), captureStatus: z.literal("dialog"),
});
const RawManualAlexaVocImportSchema = strictObject({
  asin: AsinSchema, marketplace: z.literal("US"),
  text: z.string().optional(), rawText: z.string().optional(),
}).superRefine((value, ctx) => {
  if ((value.text === undefined) === (value.rawText === undefined)) ctx.addIssue({ code: "custom", message: "exactly one of text or rawText is required" });
});
export const ManualAlexaVocImportRequestSchema = RawManualAlexaVocImportSchema.transform(({ text, rawText, ...scope }) => ({ ...scope, rawText: rawText ?? text! }));
export const CreateRunRequestSchema = strictObject({ mode: RunModeSchema, idempotencyKey: z.string().trim().min(1).max(200) });
export const SessionResponseSchema = strictObject({ authenticated: z.boolean(), user: UserSchema.nullable(), sessionIdentity: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable() });
```

Define `ManualAlexaVocRecordSchema` with `revision: z.string().regex(/^[1-9]\d*$/)`, exact seven-dimension normalized record, source `postgres | legacy-static-stale`, nullable decimal-string generation, and full `capturedAt`; define list query as `marketplace: literal("US")` plus 1–10 unique ASINs; register both 31901 routes in `v1Contracts`.

- [ ] **Step 4: Return and preserve an opaque session hash**

```ts
const sessionIdentity = createHash("sha256").update(principal.sessionId, "utf8").digest("base64url");
return SessionResponseSchema.parse({ authenticated: user !== null, user, sessionIdentity: user ? sessionIdentity : null });
```

Change `readWebSession` to return `{ user, sessionIdentity } | null`, carry both through `AuthSessionController`, and add `sessionIdentity: string` to `AuthenticatedWebSession`. Anonymous responses use `sessionIdentity: null`; no raw session id/token enters JSON.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/auth-routes.test.ts tests/agent/web-auth-session.test.ts`

Expected: PASS; malformed dual text fields, numeric revision, CA marketplace, and client cutoff are rejected.

```bash
git add shared/agent-contracts.ts server/routes/auth.ts app/lib/web-auth-session.ts app/auth-session-gate.tsx tests/agent/contracts.test.ts tests/agent/auth-routes.test.ts tests/agent/web-auth-session.test.ts
git commit -m "feat: define manual alexa voc contracts"
```

### Task 2: Add forward-only SQLite and PostgreSQL schema

**Files:**
- Create: `server/db/migrations/0019_manual_alexa_voc.sql`
- Create: `server/db/migrations/postgres/0019_manual_alexa_voc.sql`
- Modify: `tests/agent/sqlite-migrations.test.ts`
- Modify: `tests/agent/postgres-migrations.test.ts`

**Interfaces:**
- Consumes: existing `users`, `projects`, `analysis_runs`, and data snapshot tables.
- Produces: `manual_alexa_voc_revisions`, `manual_alexa_voc_heads`, `manual_alexa_voc_publication_outbox`, `manual_alexa_voc_access_audit`, `run_creation_idempotency`, plus unique `(users.id, users.organization_id)`.

- [ ] **Step 1: Add failing fresh-install and upgrade assertions**

```ts
for (const table of ["manual_alexa_voc_revisions", "manual_alexa_voc_heads", "manual_alexa_voc_publication_outbox", "manual_alexa_voc_access_audit", "run_creation_idempotency"]) {
  assert.equal(tableNames.has(table), true);
}
assert.throws(() => db.prepare("INSERT INTO manual_alexa_voc_heads (...) VALUES (...) ").run(/* mismatched hash */), /FOREIGN KEY/);
assert.throws(() => db.prepare("INSERT INTO manual_alexa_voc_revisions (...) VALUES (...) ").run(/* CA */), /CHECK/);
```

PostgreSQL tests query `pg_constraint`/`pg_indexes` and exercise the same owner, marketplace, byte-size, encrypted-field coherence, nonce uniqueness, and head tuple rejection on both a fresh schema and an 0018-upgraded schema.

- [ ] **Step 2: Run both migration tests and confirm RED**

Run: `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts`

Expected: FAIL because migration 0019 and its tables do not exist.

- [ ] **Step 3: Write both migrations with equivalent constraints**

The PostgreSQL revision core must include:

```sql
CREATE UNIQUE INDEX users_id_organization_unique ON users(id, organization_id);
CREATE TABLE manual_alexa_voc_revisions (
  organization_id text NOT NULL, marketplace text NOT NULL CHECK (marketplace IN ('US')),
  asin text NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'), revision bigint NOT NULL CHECK (revision >= 1),
  content_hash char(64) NOT NULL, captured_at timestamptz NOT NULL, normalized_record jsonb NOT NULL,
  normalized_schema_version text NOT NULL, parser_version text NOT NULL, raw_report_sha256 char(64) NOT NULL,
  raw_report_alg_version text, raw_report_key_id text, raw_report_wrapped_dek bytea, raw_report_nonce bytea,
  raw_report_ciphertext bytea, raw_report_tag bytea, raw_report_aad_sha256 char(64),
  raw_report_plaintext_bytes integer NOT NULL CHECK (raw_report_plaintext_bytes BETWEEN 1 AND 131072),
  created_by text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, marketplace, asin, revision),
  UNIQUE (organization_id, marketplace, asin, revision, content_hash, captured_at),
  UNIQUE (raw_report_key_id, raw_report_nonce),
  FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id),
  CHECK ((raw_report_alg_version IS NULL AND raw_report_key_id IS NULL AND raw_report_wrapped_dek IS NULL AND raw_report_nonce IS NULL AND raw_report_ciphertext IS NULL AND raw_report_tag IS NULL AND raw_report_aad_sha256 IS NULL) OR (raw_report_alg_version='AES-256-GCM/v1' AND raw_report_key_id IS NOT NULL AND octet_length(raw_report_wrapped_dek)>0 AND octet_length(raw_report_nonce)=12 AND octet_length(raw_report_ciphertext) BETWEEN 1 AND 135168 AND octet_length(raw_report_tag)=16 AND raw_report_aad_sha256 IS NOT NULL))
);
```

Add the descending cutoff index, composite head FK, outbox uniqueness/status/lease fields and generation, audit purpose/result fields, and run idempotency unique `(organization_id,idempotency_key)` with fingerprint/run/snapshot/completed timestamps. SQLite uses `TEXT` JSON, `BLOB`, `length(blob)`, `GLOB`-compatible ASIN validation, `INTEGER` revision/generation, the same logical checks and unique keys, and `PRAGMA foreign_keys=ON`; it stores/retrieves revision through `CAST(... AS TEXT)`.

- [ ] **Step 4: Verify fresh and upgrade GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts`

Expected: PASS on empty database and latest-old-version upgrade; deliberate tuple, tenant, nonce, marketplace, ciphertext, and byte violations are rejected.

- [ ] **Step 5: Commit**

```bash
git add server/db/migrations/0019_manual_alexa_voc.sql server/db/migrations/postgres/0019_manual_alexa_voc.sql tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
git commit -m "feat: add manual alexa voc persistence schema"
```

### Task 3: Implement the versioned AES-GCM envelope

**Files:**
- Create: `server/security/manual-alexa-voc-cipher.ts`
- Create: `tests/agent/manual-alexa-voc-cipher.test.ts`
- Modify: `server/config.ts`

**Interfaces:**
- Consumes: `MANUAL_VOC_RAW_REPORT_KEYRING` JSON `{activeKeyId,keys:{[keyId]:base64url32ByteKek}}`.
- Produces: `ManualAlexaVocCipher.encrypt`, `.decrypt`, `.rewrap`; `ManualAlexaVocCipherUnavailableError` and `ManualAlexaVocCipherIntegrityError`.

- [ ] **Step 1: Write RED tests for roundtrip, uniqueness, tamper, rotation, bounds, and redacted errors**

```ts
const envelope = cipher.encrypt({ identity, plaintext: REPORT });
assert.equal(envelope.algVersion, "AES-256-GCM/v1");
assert.equal(envelope.nonce.byteLength, 12); assert.equal(envelope.tag.byteLength, 16);
assert.equal(cipher.decrypt({ identity, envelope }), REPORT);
assert.notDeepEqual(cipher.encrypt({ identity, plaintext: REPORT }).nonce, envelope.nonce);
assert.throws(() => cipher.decrypt({ identity: { ...identity, revision: "2" }, envelope }), ManualAlexaVocCipherIntegrityError);
assert.throws(() => createManualAlexaVocCipher({ MANUAL_VOC_RAW_REPORT_KEYRING: "" }), ManualAlexaVocCipherUnavailableError);
```

Also flip one byte independently in ciphertext, tag, wrapped DEK, and AAD identity; assert every operation fails without an error/log containing report text, nonce, tag, wrapped DEK, AAD JSON, or ciphertext.

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-cipher.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement canonical AAD, per-record DEK, KEK wrapping, and zeroization**

```ts
const aad = Buffer.from(stableJson({ organizationId, marketplace, asin, revision, normalizedSchemaVersion, parserVersion }));
const dek = randomBytes(32); const nonce = randomBytes(12); const wrapNonce = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: 16 });
cipher.setAAD(aad);
const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
const wrapper = createCipheriv("aes-256-gcm", activeKek, wrapNonce, { authTagLength: 16 });
wrapper.setAAD(Buffer.from(`manual-voc-dek\0${activeKeyId}`, "utf8"));
const wrappedDek = Buffer.concat([wrapNonce, wrapper.update(dek), wrapper.final(), wrapper.getAuthTag()]);
```

`rewrap` decrypts only the DEK with an old KEK and wraps it with the active KEK; it returns unchanged `ciphertext`, `nonce`, `tag`, content hash, revision, and capturedAt. Zeroize plaintext and DEK buffers in `finally`. Reject plaintext byte lengths outside 1–131072 before DB access.

- [ ] **Step 4: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-cipher.test.ts`

Expected: PASS, including 1000 generated records with unique `(keyId,nonce)` and old-key decrypt/new-key rewrap.

```bash
git add server/security/manual-alexa-voc-cipher.ts server/config.ts tests/agent/manual-alexa-voc-cipher.test.ts
git commit -m "feat: encrypt manual alexa voc reports"
```

### Task 4: Define repository types and implement SQLite semantics

**Files:**
- Create: `server/db/manual-alexa-voc-repository.ts`
- Modify: `server/db/repository.ts:510-570`
- Modify: `server/db/sqlite-repository.ts:446-560,6500-6540`
- Create: `tests/agent/manual-alexa-voc-sqlite-repository.test.ts`

**Interfaces:**
- Consumes: Task 2 tables and Task 3 `ManualAlexaVocEncryptedRaw`.
- Produces: canonical interfaces above; typed `ManualAlexaVocRepositoryError` kinds `connection | timeout | permission | schema | deserialize | conflict`; SQLite `put/listCurrent/listAtCutoff/lockScopes/readDatabaseClock/claimRunCreation/completeRunCreation`.

- [ ] **Step 1: Write failing repository tests**

```ts
const first = await repository.transaction(r => r.manualAlexaVoc.put(input("org-a", "B0AAAA0001", "hash-a")));
assert.deepEqual([first.record.revision, first.idempotent], ["1", false]);
const same = await repository.transaction(r => r.manualAlexaVoc.put(input("org-a", "B0AAAA0001", "hash-a")));
assert.deepEqual([same.record.revision, same.record.capturedAt, same.idempotent], ["1", first.record.capturedAt, true]);
const second = await repository.transaction(r => r.manualAlexaVoc.put(input("org-a", "B0AAAA0001", "hash-b")));
assert.equal(second.record.revision, "2");
assert.deepEqual(await scopedAsins("org-b"), []);
assert.equal((await atCutoff(first.record.capturedAt))[0]?.revision, "1");
```

Add actor/org mismatch, disabled actor, earlier-content rollback creates revision 3, idempotent retry repairs missing/failed outbox, head tuple protection, and decimal-string roundtrip tests.

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-sqlite-repository.test.ts`

Expected: FAIL because `manualAlexaVoc` is absent from `AgentRepository`.

- [ ] **Step 3: Add the repository namespace and transactional SQLite implementation**

```ts
export interface AgentRepository extends AuthenticationRepository {
  readonly manualAlexaVoc: ManualAlexaVocRepository;
  transaction<T>(operation: (repository: AgentRepository) => Promise<T>): Promise<T>;
  // existing members remain unchanged
}
```

`peekNextRevision` is legal only after `lockScopes` in the current transaction and returns the decimal next value from the locked head. `put` normalizes ASIN, verifies the actor under the same transaction, confirms `expectedRevision` equals that locked next value for a non-idempotent write, reads SQLite DB time exactly once only for a new revision, inserts revision/outbox/head, and retries one first-write PK conflict. Idempotent content returns stored time/revision and upserts only missing/failed outbox to pending. `listAtCutoff` uses a window function partitioned by full scope and validates JSON through `ManualAlexaVocNormalizedRecordSchema`; a parse failure throws `ManualAlexaVocRepositoryError("deserialize")`, not null.

- [ ] **Step 4: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/agent-run-repository.test.ts`

Expected: PASS; existing repository behavior remains green.

```bash
git add server/db/manual-alexa-voc-repository.ts server/db/repository.ts server/db/sqlite-repository.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts
git commit -m "feat: persist manual alexa voc in sqlite"
```

### Task 5: Implement PostgreSQL locks, revisions, typed failures, and outbox access

**Files:**
- Create: `server/db/postgres/manual-alexa-voc-store.ts`
- Modify: `server/db/postgres-repository.ts:1-260`
- Create: `tests/agent/postgres-manual-alexa-voc-store.test.ts`

**Interfaces:**
- Consumes: Task 4 repository contract and existing `PostgresQueryExecutor` transaction scoping.
- Produces: production `manualAlexaVoc` namespace; outbox lease/reconcile queries consumed by Task 9.

- [ ] **Step 1: Write PostgreSQL RED integration tests**

```ts
await Promise.all([put("org-a", ASIN, "hash-a"), put("org-a", ASIN, "hash-b")]);
const history = await queryRevisions("org-a", "US", ASIN);
assert.deepEqual(history.map(r => r.revision), ["1", "2"]);
assert.equal((await repository.manualAlexaVoc.listCurrent({ organizationId: "org-b", marketplace: "US", asins: [ASIN] })).length, 0);
assert.equal(await countOutboxForHead("org-a", ASIN), 1);
```

Add tests for `clock_timestamp()` exact `Z` serialization, sorted two-ASIN lock completion without deadlock, timeout/schema/permission/deserialize mapping, no fallback signal on typed failures, actor composite FK, and a revision larger than `Number.MAX_SAFE_INTEGER` returned as text.

- [ ] **Step 2: Run RED against the isolated test database**

Run: `npx tsx --conditions=react-server --test tests/agent/postgres-manual-alexa-voc-store.test.ts`

Expected: FAIL because the store and repository binding do not exist.

- [ ] **Step 3: Implement stable advisory locking and SQL**

```ts
await queries.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`manual-voc\0${organizationId}\0${marketplace}\0${asin}`]);
const clockResult = await queries.query<{ captured_at: Date }>("SELECT clock_timestamp() AS captured_at");
const capturedAt = clockResult.rows[0]!.captured_at.toISOString();
const result = await queries.query(`
  SELECT DISTINCT ON (asin) organization_id, marketplace, asin,
    revision::text AS revision, content_hash, captured_at, normalized_record,
    normalized_schema_version, parser_version
  FROM manual_alexa_voc_revisions
  WHERE organization_id=$1 AND marketplace=$2 AND asin=ANY($3::text[]) AND captured_at <= $4::timestamptz
  ORDER BY asin, captured_at DESC, revision DESC`, [organizationId, marketplace, asins, dataCutoffAt]);
const rows = result.rows;
```

Map only a successful empty result to missing/null. Map `ECONN*` to connection, `57014` to timeout, `42501` to permission, undefined-table/column and constraint drift to schema, Zod/JSON failure to deserialize, and exhausted revision conflict to conflict. Do not catch these into an empty array.

- [ ] **Step 4: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/postgres-core-repository.test.ts`

Expected: PASS with serialized concurrent histories and typed failure fixtures.

```bash
git add server/db/postgres/manual-alexa-voc-store.ts server/db/postgres-repository.ts tests/agent/postgres-manual-alexa-voc-store.test.ts
git commit -m "feat: add postgres manual alexa voc store"
```

### Task 6: Add authorized import/list services and thin Web proxies

**Files:**
- Create: `scripts/lib/alexa-voc-processing.mjs`
- Modify: `scripts/lib/alexa-voc-pipeline.mjs`
- Create: `server/services/manual-alexa-voc-service.ts`
- Create: `server/routes/manual-alexa-voc.ts`
- Modify: `server/app.ts:330-405`
- Modify: `app/lib/agent-service-client.ts:14-55`
- Rewrite: `app/api/alexa-voc/import/route.ts`
- Create: `app/api/alexa-voc/route.ts`
- Create: `tests/agent/manual-alexa-voc-service.test.ts`
- Create: `tests/agent/manual-alexa-voc-routes.test.ts`
- Modify: `tests/agent/alexa-voc-mutation-routes.test.ts`

**Interfaces:**
- Consumes: strict contracts, cipher, repository, existing same-origin authorization and `createAgentServiceClient` token/Origin/Cookie forwarding.
- Produces: authenticated 31901 POST/GET endpoints and same-origin `/api/alexa-voc/import` plus `/api/alexa-voc` proxies.

- [ ] **Step 1: Write RED service and route tests**

```ts
const response = await app.inject({ method: "POST", url: "/v1/manual-alexa-voc", headers: validProxySessionHeaders, payload: { asin: ASIN, marketplace: "US", rawText: REPORT } });
assert.equal(response.statusCode, 201);
assert.equal(response.json().record.revision, "1");
assert.equal("rawText" in response.json(), false);
assert.equal(await app.inject({ method: "POST", url: "/v1/manual-alexa-voc", headers: cookieOnly, payload }).then(r => r.statusCode), 403);
```

Exercise missing token, untrusted Origin, missing/invalid session, member/admin acceptance, exact-one text compatibility, report ASIN mismatch, fewer than 3 detected dimensions, malformed seven dimensions, 131072/131073 UTF-8 bytes, DB unavailable 503, partial GET missing list, and no raw/owner fields in JSON.

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/alexa-voc-mutation-routes.test.ts`

Expected: FAIL because the service/routes do not exist and the Web route still writes files and triggers rebuild.

- [ ] **Step 3: Split pure parsing and implement deterministic hash/encrypt/put**

```ts
const normalized = ManualAlexaVocNormalizedRecordSchema.parse(processAlexaVocText(scope.asin, rawText));
const rawReportSha256 = sha256(Buffer.from(rawText, "utf8"));
const contentHash = sha256(stableJson({ marketplace: scope.marketplace, asin: scope.asin, normalizedSchemaVersion: "alexa-voc-record/v2", parserVersion: "deterministic-alexa-parser/v3", normalizedRecord: normalized, rawReportSha256 }));
return repository.transaction(async repository => {
  await repository.manualAlexaVoc.lockScopes({ organizationId: scope.organizationId, marketplace: scope.marketplace, asins: [scope.asin] });
  const nextRevision = await repository.manualAlexaVoc.peekNextRevision(scope);
  const raw = cipher.encrypt({ identity: { ...scope, revision: nextRevision, normalizedSchemaVersion: "alexa-voc-record/v2", parserVersion: "deterministic-alexa-parser/v3" }, plaintext: rawText });
  return repository.manualAlexaVoc.put({ ...scope, createdBy: principal.userId, expectedRevision: nextRevision, normalizedRecord: normalized, normalizedSchemaVersion: "alexa-voc-record/v2", parserVersion: "deterministic-alexa-parser/v3", contentHash, raw });
});
```

Keep `processAlexaVocText` side-effect-free in `alexa-voc-processing.mjs`; `alexa-voc-pipeline.mjs` re-exports it for old CLI tests but only legacy CLIs call `saveAlexaVocToSystem`.

- [ ] **Step 4: Implement thin proxies with no worktree or publication imports**

```ts
const result = await client({ method: "POST", path: "/v1/manual-alexa-voc", headers: forwardedSessionHeaders(request), body: boundedBody, requestId });
return Response.json(result.body, { status: result.status, headers: safeResponseHeaders(result.headers) });
```

The GET proxy forwards only parsed `marketplace=US` and 1–10 unique ASINs. Delete imports/calls to `saveAlexaVocToSystem`, `resolveFormalWorktreeRoot`, `triggerBackgroundRebuild`, `autoRebuild`, reload requests, and source-tree mutation from the Web import path.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/alexa-voc-import-validation.test.ts`

Expected: PASS; successful Web POST is defined by DB commit and returns pending/deduplicated/disabled publication without invoking any rebuild spy.

```bash
git add scripts/lib/alexa-voc-processing.mjs scripts/lib/alexa-voc-pipeline.mjs server/services/manual-alexa-voc-service.ts server/routes/manual-alexa-voc.ts server/app.ts app/lib/agent-service-client.ts app/api/alexa-voc/import/route.ts app/api/alexa-voc/route.ts tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/alexa-voc-import-validation.test.ts
git commit -m "feat: proxy manual alexa voc through agent service"
```

### Task 7: Make run creation, cutoff, snapshot, and replay one transaction

**Files:**
- Modify: `server/db/manual-alexa-voc-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/db/postgres/manual-alexa-voc-store.ts`
- Modify: `server/services/analysis-run-service.ts:58-230`
- Modify: `server/services/voc-data-snapshot-service.ts:35-180`
- Modify: `server/routes/analysis-runs.ts`
- Modify: `tests/agent/analysis-run-lifecycle.test.ts`
- Create: `tests/agent/manual-alexa-voc-run-atomicity.test.ts`

**Interfaces:**
- Consumes: `createRunWithVocSnapshot` exact signature, repository transaction/locks/clock, existing project/run/stage/job/snapshot methods.
- Produces: persistent `(organizationId,idempotencyKey)` replay with original run/snapshot/stages/jobs/cutoff and linearized import/run visibility.

- [ ] **Step 1: Add RED tests for strict cutoff ownership and persistent replay**

```ts
const first = await service.createRunWithVocSnapshot({ principal, projectId, mode: "existing-data", idempotencyKey: "run-1" });
const replay = await service.createRunWithVocSnapshot({ principal, projectId, mode: "existing-data", idempotencyKey: "run-1" });
assert.deepEqual(replay, first);
assert.equal(databaseClockSpy.calls, 1);
await assert.rejects(() => service.createRunWithVocSnapshot({ principal, projectId: otherProjectId, mode: "existing-data", idempotencyKey: "run-1" }), /IDEMPOTENCY_KEY_REUSED/);
```

Add two barrier-controlled PostgreSQL tests: import commits before run scope locks release and appears in the snapshot; run fixes cutoff before import commits and excludes it until the next run. Assert old snapshots never mutate and concurrent same-key losers replay the winner.

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/analysis-run-lifecycle.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts`

Expected: FAIL because current service takes application time/client cutoff and snapshot creation is separate.

- [ ] **Step 3: Implement idempotency-before-clock transaction order**

```ts
return this.#repository.transaction(async repository => {
  const project = await requireOwnedImmutableProject(repository, input.principal, input.projectId);
  const fingerprint = sha256(stableJson({ projectId: project.id, mode: input.mode, immutableProjectScopeHash: scopeHash(project) }));
  const claim = await repository.manualAlexaVoc.claimRunCreation({ organizationId: project.organizationId, idempotencyKey: input.idempotencyKey, fingerprint });
  if (claim.kind === "conflict") throw new IdempotencyKeyReusedError();
  if (claim.kind === "replay") return readOriginalRunAndSnapshot(repository, claim.runId, claim.snapshotId);
  await repository.manualAlexaVoc.lockScopes({ organizationId: project.organizationId, marketplace: "US", asins: [...project.asins].sort() });
  const dataCutoffAt = await repository.manualAlexaVoc.readDatabaseClock();
  const source = await this.#vocSourceReader.read({ organizationId: project.organizationId, marketplace: project.marketplace, asins: project.asins, dataCutoffAt });
  const created = await createRunStagesSnapshotAndFirstJob(repository, { project, input, dataCutoffAt, source });
  await repository.manualAlexaVoc.completeRunCreation({ organizationId: project.organizationId, idempotencyKey: input.idempotencyKey, fingerprint, runId: created.run.id, snapshotId: created.snapshot.id, completedAt: dataCutoffAt });
  return Object.freeze({ run: created.run, snapshot: created.snapshot });
});
```

`claimRunCreation` first takes an org+key advisory lock. Fingerprint excludes cutoff/run/snapshot IDs. Same fingerprint replays without calling the clock or reader; different fingerprint throws 409. Adapt old core-store records by reconstructing fingerprint once from immutable project/mode; ambiguous reconstruction rejects rather than creates another run.

- [ ] **Step 4: Make existing `createRun` route call only this method**

Remove `input.dataCutoffAt ?? createdAt`; do not retain a compatibility branch. Existing `createRun(projectId,input)` delegates to `createRunWithVocSnapshot`, then loads the already-committed stages to preserve the HTTP response `{run,stages}`; repository tests verify that replay points to the original snapshot and job rows.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/analysis-run-lifecycle.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts tests/agent/postgres-analysis-run-lifecycle-store.test.ts`

Expected: PASS for replay, conflict, old-record adapter, both import/run commit orders, and strict 400 client cutoff.

```bash
git add server/db/manual-alexa-voc-repository.ts server/db/sqlite-repository.ts server/db/postgres/manual-alexa-voc-store.ts server/services/analysis-run-service.ts server/services/voc-data-snapshot-service.ts server/routes/analysis-runs.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts
git commit -m "feat: atomically snapshot manual voc runs"
```

### Task 8: Convert RepositoryVocSourceReader to dynamic DB-first reads and owner-gated legacy

**Files:**
- Create: `server/data/legacy-manual-alexa-voc-source.ts`
- Create: `server/cli/bind-legacy-manual-alexa-voc.ts`
- Modify: `server/data/repository-voc-source.ts:1-225`
- Modify: `server/routes/local-voc.ts:29-180`
- Modify: `tests/agent/voc-data-source.test.ts`
- Create: `tests/agent/manual-alexa-voc-legacy-source.test.ts`

**Interfaces:**
- Consumes: async repository reads, `LEGACY_VOC_DEFAULT_ORGANIZATION_ID`, server projection owner manifest.
- Produces: `LegacyVocReadEligibilityGate(principalOrg, marketplace, manifest): LegacyGateResult`; async `RepositoryVocSourceReader.read`.

```ts
export type LegacyGateResult =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: "owner_mismatch" | "marketplace_mismatch" | "owner_missing" | "config_missing" | "schema_mismatch" | "generation_mismatch" }>;
export function LegacyVocReadEligibilityGate(principalOrg: string, marketplace: "US", manifest: LegacyManualVocOwnerManifest | null): LegacyGateResult;
```

- [ ] **Step 1: Write RED source-selection tests**

```ts
assert.equal((await reader.read(input)).candidate?.payload.records.alexaVoc[0]?.asin, ASIN);
assert.equal(legacySpy.calls, 0); // DB record exists
await missingReader.read(input); assert.equal(legacySpy.calls, 1); // successful 0 rows
for (const kind of ["connection", "timeout", "permission", "schema", "deserialize"] as const) {
  await assert.rejects(() => failingReader(kind).read(input), ManualAlexaVocRepositoryError);
  assert.equal(legacySpy.calls, 0);
}
```

Test owner org/market/schema/generation mismatch, missing/invalid default org, no active user in configured org, exact legacy per-ASIN capturedAt, date-only stale marker, and absence of owner fields in API-shaped output.

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts`

Expected: FAIL because the reader is synchronous and imports `app/rufus-voc-data.ts` at module load.

- [ ] **Step 3: Implement DB-first async selection**

```ts
const dynamic = await manualVoc.listAtCutoff({ organizationId, marketplace: "US", asins, dataCutoffAt });
const dynamicByAsin = new Map(dynamic.map(record => [record.asin, record]));
for (const asin of asins) {
  const record = dynamicByAsin.get(asin);
  if (record) addDynamicBundle(record);
  else addLegacyOrMissing(await legacySource.readIfEligible({ principalOrg: organizationId, marketplace: "US", asin, dataCutoffAt }));
}
```

Do not catch typed repository errors into missing. Use exact revision `capturedAt`; mark fallback `legacy-static-stale` and pre-binding date-only content `legacy-static-date-only`. Update every caller/test helper to `await reader.read(...)` and pass organization.

- [ ] **Step 4: Implement audited one-time owner binding**

The CLI refuses `*`, blank, request-derived, nonexistent, inactive-user-only, or mismatched marketplace organizations. It writes an immutable owner manifest atomically once and an audit event; a second different binding fails. It reads `app/rufus-voc-data.ts` only on the server/CLI path. No Web or client module imports the legacy loader.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts tests/agent/voc-data-snapshot-service.test.ts tests/agent/data-snapshot-repository.test.ts`

Expected: PASS; only successful tenant misses invoke the gate and all infrastructure/schema failures remain source-error/503.

```bash
git add server/data/legacy-manual-alexa-voc-source.ts server/cli/bind-legacy-manual-alexa-voc.ts server/data/repository-voc-source.ts server/routes/local-voc.ts tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts tests/agent/voc-data-snapshot-service.test.ts tests/agent/data-snapshot-repository.test.ts
git commit -m "feat: read manual voc dynamically with gated legacy"
```

### Task 9: Add server-only best-effort publication outbox processing

**Files:**
- Create: `server/data/manual-alexa-voc-projection-store.ts`
- Create: `server/services/manual-alexa-voc-publication-service.ts`
- Modify: `server/agent-service.ts:52-175`
- Modify: `server/config.ts`
- Create: `tests/agent/manual-alexa-voc-publication.test.ts`
- Modify: `tests/agent/agent-service-shutdown.test.ts`
- Create: `docs/superpowers/runbooks/realtime-manual-alexa-voc-rollout.md`

**Interfaces:**
- Consumes: repository outbox lease methods and heads/revisions; `AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED`, owner projection root, lease owner/duration/backoff config.
- Produces: stoppable dispatcher/reconciler, immutable server-only projection generation and manifest, documented flag rollout/rollback, and `ManualAlexaVocTelemetry.increment(name,labels)` / `.observe(name,value,labels)`.

- [ ] **Step 1: Write RED crash/reconcile/idempotency tests**

```ts
await service.dispatchOnce();
assert.equal((await outboxRow()).status, "applied");
assert.equal((await manifest()).records[ASIN].capturedAt, revision.capturedAt);
await simulateCrashAfterCommitBeforeDispatch();
await service.reconcileOnce();
assert.equal((await outboxRow()).status, "pending");
await service.dispatchOnce(); await service.dispatchOnce();
assert.equal(await projectionGenerationCount(), 1);
```

Assert failed publication leaves DB/API record readable, leases expire/retry with bounded backoff, same-content import repairs missing/failed intent, generation is monotonic decimal text, path uses opaque owner hash, and no projection/raw/manifest enters `app`, `public`, `dist`, or build context.

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-publication.test.ts`

Expected: FAIL because publication runtime and projection store do not exist.

- [ ] **Step 3: Implement atomic owner-partitioned files and leased dispatcher**

```ts
const ownerPartition = createHmac("sha256", projectionPathKey).update(organizationId).digest("base64url");
const manifest = Object.freeze({ schemaVersion: "manual-voc-owner-manifest/v1", ownerOrganizationId: organizationId, marketplace, artifactGeneration: generation, sourceHeadsHash, generatedAt, records });
await writeTempFsyncRename(path.join(root, ownerPartition, marketplace, `generation-${generation}.json`), projection);
await writeTempFsyncRename(path.join(root, ownerPartition, marketplace, "manifest.json"), manifest);
```

Lease by `(organizationId,marketplace,asin,revision,contentHash)`, update applied only after both immutable artifact and manifest are durable, and record only safe error codes. Reconciler compares heads/outbox/manifest/hash and queues missing/failed work; it never imports projection contents back over DB heads.

Emit the exact metric names `manual_alexa_voc_write_total`, `manual_alexa_voc_read_total`, `manual_alexa_voc_overlay_lag_ms`, `manual_alexa_voc_cutoff_excluded_total`, `manual_alexa_voc_publication_total`, `manual_alexa_voc_publication_lag_seconds`, `manual_alexa_voc_outbox_total`, `manual_alexa_voc_stale_epoch_response_dropped_total`, and `manual_alexa_voc_legacy_gate_total` through the injected telemetry interface. Labels use result/source/status only and never organization text, report content, crypto material, paths, or owner manifest fields.

- [ ] **Step 4: Wire a stoppable interval and write exact rollback runbook**

Start the runtime only when enabled and repository capability exists; add it to `stopAgentServiceResources`. Define exact independent flags `AGENT_MANUAL_ALEXA_VOC_WRITE_ENABLED`, `AGENT_MANUAL_ALEXA_VOC_DYNAMIC_READ_ENABLED`, `AGENT_MANUAL_ALEXA_VOC_LEGACY_FALLBACK_ENABLED`, `AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED`, and Web `MANUAL_ALEXA_VOC_UI_ENABLED`, all default false. The runbook orders: apply migrations/keyring → enable authoritative writes/outbox → verify metrics → remove client imports/enable UI → enable dynamic run reads → observe one release → optionally enable server legacy. Rollback disables UI/dynamic/publication independently, preserves DB revisions, returns 503 on DB writes, and rebuilds projection only from heads/revisions.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-publication.test.ts tests/agent/agent-service-shutdown.test.ts`

Expected: PASS; service shutdown drains/stops the timer and publication failures never change import success.

```bash
git add server/data/manual-alexa-voc-projection-store.ts server/services/manual-alexa-voc-publication-service.ts server/agent-service.ts server/config.ts tests/agent/manual-alexa-voc-publication.test.ts tests/agent/agent-service-shutdown.test.ts docs/superpowers/runbooks/realtime-manual-alexa-voc-rollout.md
git commit -m "feat: publish server-only manual voc projections"
```

### Task 10: Enforce raw-report audit, key rewrap, and 365-day retention

**Files:**
- Create: `server/services/manual-alexa-voc-retention-service.ts`
- Create: `server/cli/rewrap-manual-alexa-voc-keys.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/db/postgres/manual-alexa-voc-store.ts`
- Modify: `server/agent-service.ts`
- Modify: `server/config.ts`
- Create: `tests/agent/manual-alexa-voc-retention.test.ts`

**Interfaces:**
- Consumes: Task 3 cipher rewrap, Task 4 audit/clear repository methods, `MANUAL_VOC_RAW_REPORT_RETENTION_DAYS_BY_ORG` strict JSON map.
- Produces: audited internal decrypt/reparse/rewrap operations and a stoppable retention sweep that clears only encrypted envelope columns.

- [ ] **Step 1: Write RED tests for audit and retention invariants**

```ts
await service.clearExpired({ organizationId: "org-a", asOf: "2027-09-01T00:00:00.000Z", actorUserId: SYSTEM_ACTOR });
const row = await readRevision("org-a", ASIN, "1");
assert.equal(row.raw_report_ciphertext, null);
assert.equal(row.raw_report_sha256, ORIGINAL_SHA);
assert.deepEqual(row.normalized_record, ORIGINAL_NORMALIZED);
assert.equal(await countSnapshotsReferencingRevision("1"), 1);
assert.deepEqual((await auditEvents()).map(event => event.purpose), ["create", "delete-policy"]);
```

Add tests proving default retention is 365 days, per-org values below 365 reject, longer policies delay clearing, all envelope columns become null together, revision/head/snapshot/report remain, denied decrypt is audited, and key rewrap changes only keyId/wrappedDEK plus its audit row.

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-retention.test.ts`

Expected: FAIL because retention service and persistent audit operations do not exist.

- [ ] **Step 3: Implement transactional audit and envelope clearing**

```ts
const retentionDays = Math.max(365, policyByOrganization[organizationId] ?? 365);
const before = new Date(asOf.getTime() - retentionDays * 86_400_000).toISOString();
return repository.transaction(async repository => repository.manualAlexaVoc.clearExpiredRaw({ organizationId, before, clearedAt: asOf.toISOString(), actorUserId }));
```

`clearExpiredRaw` updates `raw_report_alg_version`, `raw_report_key_id`, `raw_report_wrapped_dek`, `raw_report_nonce`, `raw_report_ciphertext`, `raw_report_tag`, and `raw_report_aad_sha256` to null and inserts `delete-policy` audit rows in the same transaction. It retains plaintext byte count/hash, normalized record, revision, head, snapshot, project, and report. Import writes a `create` audit row in its original transaction. There is no public raw-download route.

- [ ] **Step 4: Implement audited online rewrap and stoppable sweep**

The CLI selects tenant-scoped retained envelopes, calls `cipher.rewrap`, verifies ciphertext/tag/nonce/contentHash/revision/capturedAt byte-for-byte unchanged, updates only keyId/wrappedDEK, and writes `key-rewrap` audit. Agent startup schedules the retention sweep only when enabled and includes it in `stopAgentServiceResources`; logs contain internal ids, ASIN, revision, result, and duration only.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-retention.test.ts tests/agent/manual-alexa-voc-cipher.test.ts`

Expected: PASS for expiry boundary, longer policy, audit outcomes, tamper failure, and rewrap immutability.

```bash
git add server/services/manual-alexa-voc-retention-service.ts server/cli/rewrap-manual-alexa-voc-keys.ts server/db/sqlite-repository.ts server/db/postgres/manual-alexa-voc-store.ts server/agent-service.ts server/config.ts tests/agent/manual-alexa-voc-retention.test.ts
git commit -m "feat: audit and retain manual voc raw reports"
```

### Task 11: Add epoch-scoped immediate overlay and remove tenant client imports

**Files:**
- Create: `app/voc-display-schema.ts`
- Create: `app/manual-alexa-voc-store.ts`
- Create: `app/use-manual-alexa-voc.ts`
- Modify: `app/alexa-voc-import-panel.tsx:1-120`
- Modify: `app/page.tsx:1-35,1816-2050,3250-3310`
- Modify: `app/voc-development-summary.ts`
- Create: `tests/agent/manual-alexa-voc-client-store.test.ts`
- Modify: `tests/agent/alexa-voc-mutation-routes.test.ts`

**Interfaces:**
- Consumes: session `sessionIdentity`, authenticated GET/POST contracts, public display schema.
- Produces: `ManualVocOverlayState`, `manualVocOverlayKey`, reducer, `selectEffectiveVocByAsin`, `useManualAlexaVoc`, import `onImported` callback.

```ts
export type OverlayRecord = ManualAlexaVocRecord & Readonly<{ sessionOrgEpoch: number }>;
export type ManualVocOverlayState = Readonly<{
  identity: string;
  organizationId: string;
  sessionOrgEpoch: number;
  requestGeneration: number;
  overlay: ReadonlyMap<string, OverlayRecord>;
  statusByKey: ReadonlyMap<string, "loading" | "ready" | "missing" | "source-error" | "protocol-conflict">;
}>;
export function selectEffectiveVocByAsin(state: ManualVocOverlayState, organizationId: string, marketplace: "US", asin: string): OverlayRecord | null;
```

- [ ] **Step 1: Write RED reducer tests for tenant keys, revision ordering, epoch reset, and stale responses**

```ts
let state = createManualVocOverlayState("session-a", "org-a");
state = reduceManualVoc(state, importSucceeded({ epoch: 1, requestGeneration: 2, scope: { organizationId: "org-a", marketplace: "US" }, record: revision("4", "hash-4") }));
state = reduceManualVoc(state, hydrationSucceeded({ epoch: 1, requestGeneration: 1, scope: { organizationId: "org-a", marketplace: "US" }, records: [revision("3", "hash-3")] }));
assert.equal(selectEffectiveVocByAsin(state, "org-a", "US", ASIN)?.revision, "4");
state = reduceManualVoc(state, identityChanged("session-b", "org-b"));
assert.equal(state.overlay.size, 0); assert.equal(state.sessionOrgEpoch, 2);
```

Add same-revision/same-hash confirmation, same-revision/different-hash conflict, marketplace mismatch, org mismatch, request-generation mismatch, focus hydration, POST immediate visibility, and abort-all-before-new-identity tests.

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/alexa-voc-mutation-routes.test.ts`

Expected: FAIL because the store/hook do not exist and the matrix still reads static data.

- [ ] **Step 3: Implement the pure state machine**

```ts
export const manualVocOverlayKey = (organizationId: string, marketplace: "US", asin: string) => `${organizationId}:${marketplace}:${asin}`;
export function shouldAccept(current: OverlayRecord | undefined, incoming: OverlayRecord) {
  if (!current) return { accept: true, conflict: false };
  const order = BigInt(incoming.revision) - BigInt(current.revision);
  if (order > 0n) return { accept: true, conflict: false };
  if (order < 0n) return { accept: false, conflict: false };
  return { accept: incoming.contentHash === current.contentHash, conflict: incoming.contentHash !== current.contentHash };
}
```

`identityChanged` synchronously increments the monotonic epoch, clears overlay/cache/controller maps, aborts every in-flight request, then permits the new request. Every request captures `{sessionOrgEpoch,organizationId,marketplace,requestGeneration}` and checks all four before dispatching a success action.

- [ ] **Step 4: Wire one selector into import and matrix**

`useManualAlexaVoc` batches 1–10 current ASINs on mount, identity/marketplace/committed-scope change, and `window.focus`. POST success dispatches immediately then confirms only that ASIN by GET. Pass `onImported` into `AlexaVocImportPanel`. Matrix and panel both read `effectiveVocByAsin`; badges are `Manual Alexa · PostgreSQL r${revision}` or `Stale legacy static · generation ${generation}`. Source error preserves newer overlay and shows retry; missing shows “尚未录入”.

Move only dimension labels/prompt/workflow into `voc-display-schema.ts`. Remove all direct/indirect client imports of `rufus-voc-data.ts` and `sif-keyword-analysis-data.ts`, including `voc-development-summary.ts` paths reachable from `page.tsx`.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/alexa-voc-mutation-routes.test.ts`

Expected: PASS; POST is visible without rebuild/refresh and an old epoch response cannot update data or toast.

```bash
git add app/voc-display-schema.ts app/manual-alexa-voc-store.ts app/use-manual-alexa-voc.ts app/alexa-voc-import-panel.tsx app/page.tsx app/voc-development-summary.ts tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/alexa-voc-mutation-routes.test.ts
git commit -m "feat: hydrate manual voc with scoped overlay"
```

### Task 12: Prove client-bundle isolation, rollback behavior, and end-to-end acceptance

**Files:**
- Create: `tests/manual-alexa-voc-client-bundle.test.mjs`
- Create: `tests/agent/manual-alexa-voc-rollback.test.ts`
- Modify: `docs/superpowers/runbooks/realtime-manual-alexa-voc-rollout.md`

**Interfaces:**
- Consumes: all prior tasks and their feature flags.
- Produces: a release gate proving no tenant bundle leak and safe flag rollback.

- [ ] **Step 1: Add a failing built-artifact leak test**

```js
const forbidden = ["rufus-voc-data", "sif-keyword-analysis-data", "B0TENANT01", "TENANT_VOC_SENTINEL", "ownerOrganizationId", "sourceHeadsHash"];
for (const file of clientManifestFilesAndChunks(buildRoot)) {
  const text = await fs.readFile(file, "utf8");
  for (const sentinel of forbidden) assert.equal(text.includes(sentinel), false, `${file} leaked ${sentinel}`);
}
```

The fixture injects tenant sentinels only into server legacy inputs before build, scans client webpack/Turbopack manifests and client chunks, and restores fixtures in `finally`. Server chunks may contain module names but not raw tenant reports; client chunks may contain only `voc-display-schema` labels/prompt.

- [ ] **Step 2: Add rollback tests**

```ts
assert.equal((await importWith({ databaseAvailable: false })).status, 503);
assert.equal(staticWriteSpy.calls, 0);
assert.equal((await readWith({ dynamicEnabled: false, ownerGate: "denied" })).records.length, 0);
assert.equal((await importWith({ publisherAvailable: false })).body.publication.status, "pending");
```

Also assert dynamic run failure refuses a new real-time-dependent run by default, owner-approved stale mode is explicitly labeled, publication rebuild uses heads as input, and disabling publisher leaves revisions untouched.

- [ ] **Step 3: Run targeted RED/GREEN boundary checks**

Run: `npm run build && node --test tests/manual-alexa-voc-client-bundle.test.mjs && npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-rollback.test.ts`

Expected before final wiring: FAIL on a leaked module/sentinel or missing rollback flag. After correcting only the import graph/flag wiring: PASS with no tenant sentinel in client assets.

- [ ] **Step 4: Run the complete subproject verification matrix**

Run: `npx tsc --noEmit`

Expected: exit 0 with repository/service/API/client types consistent.

Run: `npm run lint`

Expected: exit 0 with no new warnings/errors.

Run: `npm run test:agent`

Expected: all agent tests pass.

Run: `npm run build && node --test tests/manual-alexa-voc-client-bundle.test.mjs`

Expected: stable production build succeeds and client leak scan passes.

Run: `npx tsx --conditions=react-server --test tests/agent/postgres-migrations.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts`

Expected: isolated PostgreSQL migration, repository, and concurrency integration tests pass; no production service is started or replaced.

- [ ] **Step 5: Record the release acceptance and commit**

Append exact observed commands/results to the runbook, including flags left disabled by default, migration version 0019, keyring precondition, metric names, owner-gate status, and rollback decision tree. Do not add generated build/data artifacts.

```bash
git add tests/manual-alexa-voc-client-bundle.test.mjs tests/agent/manual-alexa-voc-rollback.test.ts docs/superpowers/runbooks/realtime-manual-alexa-voc-rollout.md
git commit -m "test: verify realtime manual voc boundaries"
```

## Coverage trace

| Specification requirement | Implementation task |
| --- | --- |
| SQLite/PostgreSQL forward migrations, heads composite FK, actor/tenant constraint, audit/outbox/idempotency | 2 |
| AES-256-GCM/v1 envelope, 96-bit nonce, 128-bit tag, AAD, old KEK, rewrap, byte limits, no logs | 3 |
| Full-scope repository, revision/hash idempotency, exact DB UTC, typed read failures | 4–5 |
| Strict POST/GET, text/rawText compatibility, proxy token + Origin + session, bigint strings | 1, 6 |
| Persistent run replay before clock, one transaction/cutoff/snapshot, import/run linearization | 7 |
| 31901 asynchronous DB-first read, successful-zero-row-only legacy, owner/default-org gate | 8 |
| Same-transaction outbox, crash recovery, reconciliation, server-only per-owner projection | 2, 4–5, 9 |
| Raw access audit, key rewrap, 365-day-or-longer ciphertext retention without historical deletion | 3, 10 |
| Session/org epoch, full-scope overlay, immediate POST, stale response drop, unified selector | 1, 11 |
| Remove tenant client imports and prove bundle isolation | 11–12 |
| Independent feature flags, no static-only success, stale-only rollback, no historical deletion | 9, 12 |

## Execution discipline

Implement tasks in order. Every checkbox is one 2–5 minute action; when a code block names several assertions, paste that single cohesive fixture in one action, and when a paragraph names several files, apply the stated change to one named file per action before continuing. At the start and end of every task run `git status --short`; stage only the paths named by that task. If a named file already contains unrelated user changes, split the patch and stage only this task's hunks. Do not use `git add .`, do not clean generated data, do not amend another task's commit, do not push, and do not operate existing services during this plan.
