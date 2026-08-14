# VOC Deterministic Preprocessing Design

## Context and scope

OpenSpec 8.2 must turn an immutable VOC data snapshot into versioned, closed, deterministic facts before any model is allowed to see the data. The preprocessing owns source boundaries, denominator semantics, theme normalization, synonym merging, P0-P3 classification, safety escalation, evidence identity, stable ordering, and digesting. A later 8.3 model may consume a whitelist derived from these facts, but it may not replace a code-computed value.

This change does not add a Skill or model call, create a prompt, change the UI, add an end-to-end flow, connect a database or network source, modify snapshot 8.1 semantics, or edit generated VOC data.

## Existing flow: exact mapping

The legacy visible VOC flow is not a single function. Its current input-to-output path is:

| Stage | Existing location | Input | Transformation | Output/consumer |
|---|---|---|---|---|
| Static Alexa source | `app/rufus-voc-data.ts` | ASIN-keyed seven-dimension strings and `alexaReport.reviewCount` | Strings already contain rounded percentages and sometimes mention counts | `collectAlexaThemes` |
| Static Sorftime source | `app/sorftime-review-analysis-data.ts` | ASIN-keyed `blocks[].rows[]` with `sharePct` and `sampledReviews` | Generated review themes | `collectReviewThemesForKey` |
| Static SellerSprite source | `app/seller-sprite-mcp-review-analysis-data.ts` | Same review-analysis record shape | Captured by 8.1 but not used by the legacy development summary | 8.1 snapshot only |
| 8.1 source narrowing | `server/data/repository-voc-source.ts` | The three generated/static sources plus ordered target ASINs, marketplace, cutoff | Validates source status, target membership, marketplace, cutoff, source order and missing reasons | `buildVocSnapshotCandidate` |
| 8.1 strict payload | `server/data/voc-data-snapshot.ts` | Available source bundles | Produces strict `VocSnapshotPayload@1.0.0`, source checksums, immutable record/candidate and content hash | 8.2 strict input |
| Alexa label extraction | `app/voc-development-summary.ts:106-143` | One dimension string | Dimension-specific label parsing; explicit `约 n%` wins, otherwise a count divided by `reviewCount`, otherwise unknown | `addTheme` |
| Theme normalization | `app/voc-theme-merge.ts:17-242` | Raw label, dimension and family | Ordered family/dimension-specific regex rules; whitespace/case/parenthetical cleanup | Canonical key and label |
| Legacy aggregation | `app/voc-development-summary.ts:51-104` | Canonical themes from Alexa and Sorftime | Adds all available percentages across products and sources; a theme with no percentage falls back to brand coverage; then renormalizes the dimension to 100% | `VocThemeAggregate[]` |
| Legacy summary | `app/voc-development-summary.ts:238-258` | Product order, Alexa, Sorftime | Builds seven dimensions, guidance, brand/source arrays and sorted themes | Page and product launch analysis |
| Legacy priority display | `app/product-launch-analysis.ts:392-410,688-920` | Renormalized legacy theme percentage | Severity bands and positive/negative display strings | Visible priority tables |
| Legacy cross-table priority | `app/voc-positioning.ts` | Formatted positive, negative and unmet rows | Theme buckets, `>10`, `5..10`, `<5`, P0-P3, and a safety uplift | VOC positioning conclusion |
| Opportunity templates | `app/product-launch-analysis.ts:1319-1500` | Legacy summary plus market values | Family-specific templates, hard-coded tiers, weighted opportunity score | Product launch report |

The current legacy dimension percentage is a presentation share, not a source-native mention rate. It mixes Alexa and Sorftime percentages and therefore cannot be exposed as an 8.2 factual aggregate. It remains only a compatibility projection.

Two existing display differences from the published Skill rules are characterized rather than silently repaired in 8.2:

- `buildNegativePriorityRows` treats exactly 10% as a P0/P1 display recommendation, while the Skill assigns exactly 10% to P2.
- `buildPositivePriorityRows` describes a positive theme at or above 10% as P0, while the Skill defines a positive theme above 10% as P1.

The strict 8.2 result follows the published Skill rules. The legacy projection preserves the current visible strings. A later product decision may migrate the UI deliberately, with explicit fixture updates.

## Approaches considered

### A. Move only the legacy summary into a server module

This is the smallest extraction and gives Node importability. It is rejected because its percentage is a cross-source renormalization, it has no stable evidence identity, and missing denominators collapse into brand presence. Making this the 8.2 contract would encode the exact denominator error the change must prevent.

### B. Build one new flat aggregate and update the page to use it

This would give one code path but would either add incomparable percentages or change current page output. It also makes a silent migration of the two legacy priority differences likely. It is rejected because it cannot satisfy both source independence and characterization compatibility.

### C. Shared deterministic kernels, strict fact result, compatibility projection (recommended)

Move canonical theme rules, Alexa parsing, deterministic ordering, threshold classification, and safety detection into browser-independent pure modules. The strict snapshot preprocessor uses those kernels and never creates a cross-source percentage. The legacy adapter uses the same kernels but retains the existing dimension renormalization and visible priority wording behind characterization tests. This creates one normalization and one strict priority implementation while acknowledging that legacy rendering is a compatibility projection, not a fact source.

## Module boundaries

The implementation uses focused modules under `server/domain/voc/`:

- `theme-normalization.ts`: canonical dimensions/families, the current ordered synonym rules, raw label cleaning, Alexa label/mention parsing, and stable code-point comparison. It has no React, browser, database, network, clock, random, or runtime framework dependency.
- `priority-rules.ts`: the published `>10`, `5..10`, `<5`, and unknown rules; fail-closed safety/structural failure escalation; stable priority sorting; compatibility labels needed by the legacy renderer.
- `legacy-summary.ts`: the existing Alexa+Sorftime dimension-to-100% projection parameterized by explicit input data. It owns the intentionally legacy-only cross-source renormalization.
- `preprocess-voc-snapshot.ts`: strict 8.1 record validation, source facts, source-record metrics, evidence index, closed output schema, deep freeze and canonical digest.

`app/voc-theme-merge.ts` becomes a compatibility re-export of the shared canonical function. `app/voc-development-summary.ts` becomes a thin adapter that supplies the existing static Alexa and Sorftime data to `legacy-summary.ts`. `app/voc-positioning.ts` calls the shared strict threshold classifier instead of retaining its own threshold implementation. `app/product-launch-analysis.ts` continues to consume the legacy summary, so existing rendered fixtures remain stable.

The preprocessing module accepts only `VocDataSnapshotRecordSchema@1.0.0`. This provides snapshot ID, run ID, content hash, cutoff, ordered target ASINs, source provenance and strict payload together. Payload-only callers can first construct or persist the 8.1 record; 8.2 does not invent snapshot identity for evidence.

## Strict result contract

The result is `VocDeterministicPreprocessingResult@1.0.0`, validated by a strict Zod schema and deeply frozen. It contains only these top-level areas:

- `schemaVersion` and `kind`;
- `snapshot`: input snapshot ID, run ID, content hash, marketplace, cutoff and ordered target ASINs;
- `availability`: one entry for each closed source ID in fixed source order, record coverage, available/partial/unavailable state, captured-at/reference when present, sample-denominator state, and `comparable | not-comparable | partial | unknown` boundary;
- `dimensions`: seven fixed dimensions in fixed order, each with canonical themes;
- `evidenceIndex`: stable evidence records that belong to this snapshot;
- `canonicalDigest`: lowercase SHA-256 of the canonical semantic facts. The upstream 8.1 `contentHash` remains in `snapshot` as provenance but is excluded from this fact digest because 8.1 intentionally hashes review row order while 8.2 treats row order as semantically unordered.

Each canonical theme contains its key and label, family-independent dimension, deterministic priority, all priority reasons, an optional non-downgrade reason, evidence IDs, and source-record metrics. A metric contains exactly:

- source ID, source reference, marketplace, captured-at if known, ASIN and stable record key;
- raw label and raw basis (`explicit-percentage`, `mention-count`, `review-share-percentage`, or `presence-only`);
- `mentionCount`, `sampleCount`, and `mentionPct`, each nullable when genuinely unknown;
- a denominator scope fixed to one source record and a comparability status.

Null means unknown. Missing or malformed data never becomes numeric zero. The preprocessor rejects malformed or non-finite inputs through the 8.1 schema before processing.

No theme-level percentage is computed across different sources, ASINs, dates or denominators. A theme exposes its independent metrics in stable order and may expose the maximum known percentage only as a sorting key, not as an aggregate claim.

## Parsing, normalization and denominator rules

The current synonym rules retain their order, family filters and dimension filters. Raw labels are trimmed, numbered prefixes and Alexa brackets are removed exactly as today, whitespace is collapsed for identity, and key comparison is lower-cased. New rules are not inferred by a model.

For Alexa evidence:

- an explicit `约 n%` is preserved as the percentage;
- an explicit positive mention count is preserved as `mentionCount`;
- `alexaReport.reviewCount` is preserved as `sampleCount`, including zero;
- a percentage is derived from count/sample only when the count is present and the sample count is greater than zero;
- no statistical token produces a `presence-only` metric with all numeric fields null.

For Sorftime and SellerSprite evidence, `sharePct` and `sampledReviews` are preserved. `mentionCount` stays null because the snapshot stores a rounded percentage, not the original row count; reconstructing a count would fabricate precision.

Percentages are retained as finite 0-100 numbers. No cross-record rounding occurs. Legacy display formatting remains: one decimal at or above 1%, two below 1%. Strict sorting uses priority rank, safety rank, maximum known source-record percentage, distinct ASIN count, canonical key and then evidence ID. String tie-breaks use code-point order rather than locale-dependent collation.

Input record order follows the 8.1 target ASIN order. The output preserves that order only in `snapshot.asins`. Semantically unordered blocks, rows, theme metrics and evidence are canonical-sorted, so their input permutation does not alter output or digest.

## Priority and fail-closed safety rules

The strict classifier evaluates independent source-record metrics without summing them:

- P0 if any negative metric is greater than 10%;
- P1 if any positive or unmet metric is greater than 10% and no P0 rule applies;
- P2 if any known related metric is between 5% and 10%, inclusive, and no higher rule applies;
- P3 if at least one percentage is known and all are below 5%;
- `unknown` if no percentage is known and no safety rule applies.

Safety, compliance, unusable product, structural failure, severe damage and concentrated-return themes are P0 regardless of frequency, missing percentages, source conflict or positive evidence. Their `cannotDowngradeReason` states the matched closed safety rule. Once any P0 reason is present, lower-frequency or conflicting source facts remain evidence but cannot reduce priority.

Safety matching is a closed, reviewable list of current Chinese and English terms already represented by the Skill and existing app rules. It is applied to normalized and raw labels. It does not scan full review text or allow model-provided rules.

## Evidence identity and privacy

Every evidence ID is the SHA-256 of a canonical tuple containing snapshot ID, source ID/reference, marketplace, ASIN, dimension, normalized theme key, raw label, source-record basis and its nullable numeric facts. Identical duplicate semantic rows deduplicate; distinct rows cannot collide without a SHA-256 collision. The upstream content hash remains separately visible in snapshot provenance. Evidence does not use mutable array positions, so row/block permutation does not change identity.

Each theme reference is checked against the final evidence index. Each evidence entry is generated only while traversing the validated target snapshot and therefore cannot point to another snapshot, run, ASIN, marketplace or source. The 8.1 record has no organization/tenant field; 8.2 accepts no external evidence references and binds all evidence to its snapshot/run IDs, so it cannot introduce a cross-tenant reference. Authorization remains the repository/service responsibility attached to the run.

The preprocessor has no logger and no side effects. It does not include complete review content, payloads, secrets, or connector responses. Evidence retains only source provenance, stable keys, labels already present in structured theme rows, and numeric facts. The future 8.3 whitelist will select from this result; 8.2 does not build a prompt.

## Errors and immutability

Unknown fields, wrong versions, target drift, source checksum drift, dangling evidence, non-finite values and malformed records fail before a result is returned. No partial result is emitted after a validation failure. Legitimate source absence is represented in availability rather than thrown.

Both input and output are treated as immutable. The parser clones validated input; result objects, arrays and nested values are deeply frozen. Repeated calls with the same semantic input return deeply equal output and the same digest without mutating the caller's record.

## Test strategy

All production changes follow RED-GREEN-REFACTOR.

Characterization tests first lock the existing scooter and lighting outputs from the real repository fixtures: theme labels, percentages, sorting, source/brand order, negative/positive visible priority strings, combined P0-P3 positioning rows and opportunity tiers. These tests explicitly retain the two legacy priority differences described above.

Strict preprocessing tests cover:

- full scooter and lighting snapshots;
- partial/missing source coverage and independent source denominators;
- conflicting percentages across all three sources without addition;
- duplicate/synonym themes, case, whitespace, Chinese and English labels;
- zero denominator, unknown statistics, invalid/non-finite numbers and strict unknown-field rejection;
- exactly 5%, exactly 10%, greater than 10%, ties and deterministic code-point tie-breaks;
- input block/row permutation, repeated runs and canonical digest stability;
- low-frequency safety evidence, missing-frequency safety evidence and conflicting safety evidence remaining P0;
- evidence uniqueness, no dangling references and snapshot/source/marketplace/ASIN binding;
- deep immutability and no caller mutation;
- import from an ordinary Node process with no browser or application runtime;
- generated source files, migrations 0001-0005 and package lock remaining unchanged.

## Delivery boundaries

The design and implementation are committed atomically in small steps. OpenSpec task 8.2 is checked only after focused tests and all requested repository gates pass. Tasks 8.3 and later remain unchecked. No dependency is added, no audit vulnerability is addressed, and the branch/worktree remains available for independent review and integration.
