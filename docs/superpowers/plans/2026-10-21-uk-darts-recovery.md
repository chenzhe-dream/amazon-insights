# UK original seven-ASIN candidate recovery

User authorization: continue diagnosis and make original UK darts collection and analysis work in the candidate. Keep the exact seven ASINs and original candidate project, preserve failed history, and use only 33900/33901. Do not change 31900/31901 or 32900/32901.

## Evidence and design

Original project `6fb02de8-60dd-4c87-b168-8bbcb3cce277`, job `fcbd86a0-501c-42b2-b28d-6f7d851db03b`, ASINs B0FJ4T6V2C, B0F5NRLWB6, B0C6FP6LMY, B0FPXDD2D4, B0DQCF6ZVZ, B0DLB22T15, B0GHQW7GYY.

Sorftime GB details return exact `#ASIN` placeholder records for four ASINs. Those are unavailable product evidence, not numeric zero observations. A product-trend invocation error on one such ASIN opened the whole job's provider breaker. B0DQCF6ZVZ instead has a valid detail and trend response with -1 unknown values; preserve that distinction. Do not globally suppress RPC errors or weaken auth/quota/transport breakers.

SIF UK current 30-day keyword queries and SellerSprite UK traffic_keyword queries are empty. Confirmed parent B0CVNMW6DG is also empty. SIF UK September 2026 query for the original B0C6FP6LMY returns four real keywords. Bounded previous-complete-month fallback is acceptable as explicitly dated historical evidence; it must never be relabeled as current 30-day data. All seven target identities remain in the snapshot and missing coverage remains visible. Do not substitute new products, other countries, invented keywords or market-wide terms for ASIN evidence.

Review-stage readiness alone is insufficient: the original 1/7 ready record is verified zero-review evidence, with no usable VOC rows. Direct governed probes confirm Sorftime B0C6FP6LMY returns an unstructured Customers Say summary and no review samples, while SellerSprite UK review returns eight real samples for the same ASIN. Add an explicit UK-only candidate fallback after valid-empty Sorftime results, retain provider attribution through publication and frozen model inputs, and preserve review validation gates.

## Implementation and verification

- [ ] Add strictly verified Sorftime missing-product handling around dependent trend requests. Reuse governed/cache-aware product detail, isolate exact unavailable placeholders without fabricated tool responses or zeroes. Preserve real provider failures and receipts. Cover missing, valid unknown, wrong identity, auth/quota, and sibling ASIN behavior.
- [ ] Add candidate-explicit, bounded previous-month fallback only after valid-empty current SIF results. Preserve query window/provenance in collector, cache, stage output, frozen analysis input and UI/model evidence labels. Never fallback on errors, quota or cross-site responses. Retain known-empty records so they are not mistaken for uncollected ASINs.
- [ ] Add candidate-explicit UK SellerSprite review fallback after valid-empty Sorftime evidence. Use governed scoped collector paths, bounded pagination and exact selected ASINs. Preserve separate provider attribution in stage output, frozen inventory/model and UI. No transport/auth/quota bypass or manufactured VOC evidence.
- [ ] Review source changes and run targeted regressions/typecheck/build. Enable only the explicit candidate fallback option; record commit, sourceHash, PIDs and six-port before/after comparison.
- [ ] Create repair-incomplete collection through the public API for the same project and all seven ASINs. Preserve parent job and exact repaired run lineage. Inspect per-ASIN outcomes and scoped input readiness.
- [ ] Run actual VOC and product definition with explicit partial/historical evidence, verify saved reports, idempotent replay, model usage ledger, and browser rendering. If upstream gaps remain, retain them; no weakening of final evidence/analysis validators to publish.

Raw probes, timestamps, schemas, hashes and payloads are outside source control under the candidate runtime's `evidence/uk-darts-investigation/`. This extends the approved candidate repair workflow; no production deployment is authorized.
