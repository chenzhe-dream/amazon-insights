# Product pool supplier compatibility — 2026-09-17

The live acceptance coordinator observed SellerSprite returning 100 valid rows for a topN=10 request. The collector previously rejected any response larger than the requested local pool. This was an application assumption, not evidence that the provider response was malformed. Fixed-ASIN historical requests also rejected any extra returned member.

The collector now validates the entire response up to 1000 rows and the existing 8 MB payload boundary, then selects the first requested number in provider order or filters against the fixed ASIN set. It never substitutes absent selected members. Raw payload, original indexes and received coverage remain unchanged; sampling.selectedSize describes the selected count separately. For a fixed query containing extra rows, raw evidence expectedCount remains unknown while requestedSize, selectedAsins and missingAsins describe selection coverage.

Duplicate/invalid ASINs and mismatching site/category/month/currency echoes anywhere in the full response still reject it. Missing metrics on selected products remain explicit gaps. No source rankings are relabeled as verified BSR.

Validation:

- Before the change: three regression cases failed (100→10, extra-only fixed response, mixed fixed response).
- After the change: product-pool collector tests 27/27 passed, including oversized payload row guard, discarded-row identity/scope rejection, immutable raw evidence, zero versus unknown and cancellation/deadline cases.
- Source-step integration suite passed 12/12 (including its parent test): durable source/input receipts, fixed-member missing gaps, real Agent Service runtime wiring and rollback.
- Targeted ESLint and full TypeScript check passed.
- OpenSpec strict validation passed.

These regression results use synthetic fixtures matching the observed provider shape. Actual supplier/model workflow retry and release status are recorded separately by the live acceptance coordinator; this file does not claim formal production deployment or all-module live completion.

## Frozen replay correction

The next live shape run reached `select-shape-members` but failed because product-month replay still normalized the raw response as a pool of 100 and compared those 100 reconstructed records with the newly frozen 10-member snapshot. Changed coverage descriptions also prevented legacy source replay. The public report reader uses this same path.

Replay now derives selection from frozen expectedRecordIds and verifies original sourceIndex and all normalized record values. It compares the complete regenerated factual source evidence, allowing only the explicit old/current coverage descriptions and a validated expected-count difference between head and fixed-member replay. The original source object and content hash remain untouched.

Three valid replay cases failed before the correction and passed afterward: raw100/snapshot10, fixed subset with extra members and a missing selected member, and legacy coverage text. The fourth test rejects source tampering, unknown coverage text and forged record indexes. Those four plus metadata/period projections passed 14/14; targeted ESLint passed. No additional real provider calls were made by this correction.

Full TypeScript and strict OpenSpec validation also passed after the correction. The shape-flow integration suite passed 3/3 (including its parent), covering actual HTTP report reads, revision writes, fixed-history collection and failed-month retry.
