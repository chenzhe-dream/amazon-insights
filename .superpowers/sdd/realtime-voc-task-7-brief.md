### Task 7: Convert RepositoryVocSourceReader to dynamic DB-first reads and owner-gated legacy

**Files:**
- Create: `server/data/legacy-manual-alexa-voc-source.ts`
- Create: `server/cli/bind-legacy-manual-alexa-voc.ts`
- Modify: `server/data/repository-voc-source.ts:1-225`
- Modify: `server/routes/local-voc.ts:29-180`
- Modify: `server/services/voc-data-snapshot-service.ts:35-180`
- Modify: `tests/agent/voc-data-source.test.ts`
- Modify: `tests/agent/voc-data-snapshot-service.test.ts`
- Modify: `tests/agent/data-snapshot-repository.test.ts`
- Modify: `tests/agent/postgres-data-snapshot-repository.test.ts`
- Modify: `tests/agent/voc-deterministic-preprocessing.test.ts`
- Modify: `tests/agent/helpers/voc-positioning-fixture.ts`
- Create: `tests/agent/manual-alexa-voc-legacy-source.test.ts`

**Interfaces:**
- Consumes: Task 5 async repository reads, `LEGACY_VOC_DEFAULT_ORGANIZATION_ID`, and the server projection owner manifest.
- Produces: `LegacyVocReadEligibilityGate(principalOrg, marketplace, manifest): LegacyGateResult` and the async `RepositoryVocSourceReader.read` consumed by Task 8.

```ts
export type LegacyGateResult =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: "owner_mismatch" | "marketplace_mismatch" | "owner_missing" | "config_missing" | "schema_mismatch" | "generation_mismatch" }>;
export function LegacyVocReadEligibilityGate(principalOrg: string, marketplace: "US", manifest: LegacyManualVocOwnerManifest | null): LegacyGateResult;
```

- [ ] **Step 1: Write RED source-selection tests**

```ts
assert.equal((await reader.read(input)).candidate?.payload.records.alexaVoc[0]?.asin, ASIN);
assert.equal(legacySpy.calls, 0);
await missingReader.read(input); assert.equal(legacySpy.calls, 1);
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
  if (record) addDynamicBundle(record.normalizedRecord);
  else addLegacyOrMissing(await legacySource.readIfEligible({ principalOrg: organizationId, marketplace: "US", asin, dataCutoffAt }));
}
```

Do not catch typed repository errors into missing. Dynamic records already use Task 1's canonical shared schema (including `alexaReport`), so no adapter invents missing header fields. Use exact revision `capturedAt`; mark fallback `legacy-static-stale` and pre-binding date-only content `legacy-static-date-only`. Update every caller/test helper to `await reader.read(...)` and pass organization.

- [ ] **Step 4: Implement audited one-time owner binding**

The CLI refuses `*`, blank, request-derived, nonexistent, inactive-user-only, or mismatched marketplace organizations. It writes an immutable owner manifest atomically once and an audit event; a second different binding fails. It reads `app/rufus-voc-data.ts` only on the server/CLI path. No Web or client module imports the legacy loader.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts tests/agent/voc-data-snapshot-service.test.ts tests/agent/data-snapshot-repository.test.ts tests/agent/postgres-data-snapshot-repository.test.ts tests/agent/voc-deterministic-preprocessing.test.ts && npx tsc --noEmit`

Expected: PASS; only successful tenant misses invoke the gate, all infrastructure/schema failures remain source-error/503, and every caller compiles against the async organization-scoped signature.

```bash
git add server/data/legacy-manual-alexa-voc-source.ts server/cli/bind-legacy-manual-alexa-voc.ts server/data/repository-voc-source.ts server/routes/local-voc.ts server/services/voc-data-snapshot-service.ts tests/agent/voc-data-source.test.ts tests/agent/manual-alexa-voc-legacy-source.test.ts tests/agent/voc-data-snapshot-service.test.ts tests/agent/data-snapshot-repository.test.ts tests/agent/postgres-data-snapshot-repository.test.ts tests/agent/voc-deterministic-preprocessing.test.ts tests/agent/helpers/voc-positioning-fixture.ts
git commit -m "feat: read manual voc dynamically with gated legacy"
```
