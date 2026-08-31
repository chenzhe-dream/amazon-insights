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

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-publication.test.ts tests/agent/agent-service-shutdown.test.ts && npx tsc --noEmit`

Expected: PASS; service shutdown drains/stops the timer and publication failures never change import success.

```bash
git add server/data/manual-alexa-voc-projection-store.ts server/services/manual-alexa-voc-publication-service.ts server/agent-service.ts server/config.ts tests/agent/manual-alexa-voc-publication.test.ts tests/agent/agent-service-shutdown.test.ts docs/superpowers/runbooks/realtime-manual-alexa-voc-rollout.md
git commit -m "feat: publish server-only manual voc projections"
```
