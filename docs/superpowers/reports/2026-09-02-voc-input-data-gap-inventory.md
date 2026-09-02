# VOC input-data gap inventory — 2026-09-02

## Scope and evidence boundary

This is a read-only classification of the retained three-ASIN sync diagnostics. It contains no Provider response bodies, credentials, or unbounded payload fields. The evidence cutoff is completed job `fdb10df9-9cdb-44d6-bf10-9af74c62b013` (2026-09-02 08:09:53Z) and its safe generated-state/postcondition records. The job ran after `5ac4b7a`; no row is a missing-rerun finding. Current baseline `80bc5f9` includes Task 2 rejected-cache persistence.

`—` means a ready row has no remaining gap. Every remaining-gap disposition is one of the required values.

## Three-ASIN × module inventory

| ASIN | Stage | Operation | Failure kind | Cause code | Boundary | Trusted evidence | Local reproduction | Disposition |
|---|---|---|---|---|---|---|---|---|
| B074QLWRDQ | SIF keywords | `market_get_asin_keyword_signals` | none | READY | generated record | Latest job ready | No gap | — |
| B096LRXPBW | SIF keywords | `market_get_asin_keyword_signals` | schema | `SIF_KEYWORD_SCHEMA_INVALID` | strict SIF consumer | Generated record is `schema-error`, zero rows; job compressed it to upstream-empty | Fake diagnostics prove local schema isolation; no bounded failing field was retained | external/provider-evidence-required |
| B0BTM28F9N | SIF keywords | `market_get_asin_keyword_signals` | none | READY | generated record | Latest job ready, three keywords | No gap | — |
| B074QLWRDQ | Sorftime reviews | `product_reviews` | schema | `MCP_SCHEMA` | tool-content | Safe diagnostic only: allowlisted top-level/fixed-field shape metadata is unknown | `provider-bounded-diagnostics.test.mjs` proves this is value-free | external/provider-evidence-required |
| B096LRXPBW | Sorftime reviews | rating cache / review analysis | stale cache | `CATALOG_CONFLICT` | local cache policy | Prior ready `0/0` conflicts with catalog 4.2 / 42; Task 2 rejects and persists it | Cache conflict and no-key persistence fake tests pass | fixed-by-task-2 |
| B0BTM28F9N | Sorftime reviews | `product_customers_say` / `product_reviews` | none | READY | generated record | Ready with five sampled reviews | No gap | — |
| B074QLWRDQ | child sales | `product_variations.SalesAmount` | unverified-empty | `UNVERIFIED_EMPTY` | parser / verified-empty contract | Zero rows marked verified empty; no recognized response container is retained | Cannot invent a Provider shape in a fake fixture | external/provider-evidence-required |
| B096LRXPBW | child sales | `product_variations.SalesAmount` | none | READY | generated record | Ready with one child and positive sales | No gap | — |
| B0BTM28F9N | child sales | `product_variations.SalesAmount` | unverified-empty | `UNVERIFIED_EMPTY` | parser / verified-empty contract | Zero rows marked verified empty; no recognized response container is retained | Cannot invent a Provider shape in a fake fixture | external/provider-evidence-required |
| B074QLWRDQ | price strategy | `product_detail` + `product_trend(Price)` | none | READY | generated record | Ready, current price 99.99 | No gap | — |
| B096LRXPBW | price strategy | `product_detail` + `product_trend(Price)` | upstream-empty | `PRICE_INPUT_UNCONFIRMED` | parser / postcondition | No record or bounded input diagnostic; detail-price early return is possible, not proven | Need safe-evidence regression fixture; do not infer fallback | external/provider-evidence-required |
| B0BTM28F9N | price strategy | `product_detail` + `product_trend(Price)` | upstream-empty | `PRICE_INPUT_UNCONFIRMED` | parser / postcondition | No record or bounded input diagnostic; possible early return is not ASIN proof | Need safe-evidence regression fixture; do not infer fallback | external/provider-evidence-required |
| B074QLWRDQ | FBA | `product_detail.fba_fee` | none | READY | generated record | Ready, fee 18.28 | No gap | — |
| B096LRXPBW | FBA | `product_detail.fba_fee` | upstream-empty | `FBA_FEE_ABSENT` | positive-fee parser | `fbaFee=null`; no credential/transport defect retained | No code defect evidenced | external/provider-evidence-required |
| B0BTM28F9N | FBA | `product_detail.fba_fee` | none | READY | generated record | Ready, fee 21.2 | No gap | — |
| B074QLWRDQ | category | `product_detail.node_id` + `category_trend` | connector failure | `NODE_ID_UNDIAGNOSED` | batch control flow | Only stage-level `CONNECTOR_FAILED`; unresolved node throws and aborts cohort | Existing fake diagnostics do not supply a per-ASIN node fixture | separate-plan-required |
| B096LRXPBW | category | `product_detail.node_id` + `category_trend` | connector failure | `BATCH_ABORT_NO_PER_ASIN_DIAGNOSTIC` | batch control flow | Missing despite catalog subcategory; no independent result persisted after cohort abort | Requires separate per-ASIN settlement/reason-code design | separate-plan-required |
| B0BTM28F9N | category | `product_detail.node_id` + `category_trend` | connector failure | `BATCH_ABORT_NO_PER_ASIN_DIAGNOSTIC` | batch control flow | Missing despite catalog subcategory; no independent result persisted after cohort abort | Requires separate per-ASIN settlement/reason-code design | separate-plan-required |
| B074QLWRDQ | variant / Listing | `variant:sync` / Listing sync | wiring | `VARIANT_BUILDER_SCOPE_MISMATCH` | command/env handoff | Listing ready (six images, A+); catalog has three variants; structured variant data empty. Sorftime-labelled stage invokes SellerSprite builder with `SORFTIME_ASINS`. | Deterministic local command-scope regression | separate-plan-required |
| B096LRXPBW | variant / Listing | `variant:sync` / Listing sync | wiring | `VARIANT_BUILDER_SCOPE_MISMATCH` | command/env handoff | Listing ready (six images); catalog has five variants; structured variant data empty | Deterministic local command-scope regression | separate-plan-required |
| B0BTM28F9N | variant / Listing | `variant:sync` / Listing sync | wiring | `VARIANT_BUILDER_SCOPE_MISMATCH` | command/env handoff | Listing ready (seven images, A+); catalog has four variants; structured variant data empty | Deterministic local command-scope regression | separate-plan-required |

## Evidence gate and required next plans

- `fixed-by-task-1`: none. Task 1 addresses Alexa VOC ASIN normalization, outside these seven sync modules.
- `fixed-by-task-2`: B096 reviews. A later safe sync is required to publish a result, but rerun alone was not the remedy.
- B074 `product_reviews` is specifically `schema / MCP_SCHEMA / tool-content / external/provider-evidence-required`. Current diagnostics expose unknown shape only and cannot justify an adapter. A future probe may retain bounded metadata such as content-type/token-class/length-bucket and wrapper/JSON outcome, never response text.
- **Child sales, SIF, and price are evidence gates only.** First retain or derive a safe bounded structural fixture; do not guess a Provider wrapper, field mapping, verified-empty contract, or price fallback.
- **Separate plan: variant builder/environment wiring.** Align builder, connector label, and ASIN environment variable, with a command-scope regression.
- **Separate plan: category.** One unresolved `node_id` must not stop the cohort; design per-ASIN settlement, bounded reason codes, and final aggregation before implementation.

No Provider call, POST, deployment, restart, generated-data rewrite, or Provider-adapter change was performed.

## Local verification

Existing local fake fixtures only:

```text
node --test tests/scripts/provider-bounded-diagnostics.test.mjs tests/scripts/provider-degradation.test.mjs tests/scripts/sorftime-review-verified-empty.test.mjs tests/scripts/commerce-data-validity.test.mjs
63 passed, 0 failed
```
