# German manual VOC candidate verification

## Problem and change

The German project could not discover pending imports or submit manual Alexa VOC. Several layers assumed US: browser requests, Web pending proxy, contracts, encrypted identities, PostgreSQL constraints, normalization recovery, publication and analysis source reads. Propagate the authenticated project's explicit marketplace through these layers, reject cross-market records and retain scope authorization. Migration 0073 expands four PostgreSQL table constraints to US/UK/DE/CA.

Legacy US static data remains US-only. SQLite can return empty non-US lists and lock those scopes for existing review workflows; its manual record writes remain US-only. Automatic non-US model scheduling and legacy command-line imports are outside this change.

Live freeform input exposed a second issue: the queued provider identity omitted the `:json-object` suffix used by the worker. This caused a configuration fingerprint mismatch before any model invocation. The service now derives one effective provider identity for submission and execution.

## Candidate isolation

- Branch: `codex/de-manual-voc-import-20261021`; base `454c8279`.
- Web/Agent: loopback-only `34900/34901`.
- Dedicated PostgreSQL container: `amazon-de-manual-voc-20261021`, loopback `59050`, database `de_manual_voc`.
- Public schema cloned from formal storage; migration applied only to candidate. No active cloned collection jobs. Candidate automatic intents cleared and external publication/retention disabled.
- Runtime and evidence: `C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/de-manual-voc-20261021`.
- Formal `31900/31901` and other candidates were not switched or edited.

## Verified results

- Focused regression set: 258 passed before final SQLite compatibility addition; SQLite repository suite subsequently 21/21 passed.
- DE PostgreSQL normalization/recovery cases: 5/5 passed with controlled model providers.
- DE PostgreSQL persistence/source and projection isolation cases: 2/2 passed.
- Browser component regressions: 4/4 passed. Proxy route suite: 11/11 passed, including DE forwarding.
- TypeScript check and production build passed. Final source fingerprint and running service identities recorded in runtime evidence.
- Actual HTTP import through candidate Web: B09Q8MJP3R, B09GY72DX2, B09VP9LJQX, B0GCNJJDZP and B07KSDSSS1 all returned 201 in a separate synthetic-test organization. Repeat imports retained revision 1. List readback and downstream source reader both returned five DE records. Wrong US scope returned 403; missing marketplace returned 400.
- Original project's browser: DE list and pending requests both returned 200, no page errors, and a temporary unsubmitted draft enabled the import button. Clearing the draft disabled it normally. Original organization retained zero synthetic manual records.

## Limitations and acceptance still needed

The user subsequently supplied the complete B09Q8MJP3R report. Actual browser submission returned 202, live normalization completed successfully, and PostgreSQL stored DE revision 1. A browser reload displayed all seven dimensions without page errors. The downstream source reader returned this one DE record. Runtime evidence includes the original input, receipt, normalized record, browser checks and source check. The remaining four ASINs have synthetic pipeline verification only, not imported user reports.

The model audit recorded 6,303 input and 909 output tokens; the configured ledger estimate is USD 0.117570, not a provider billing reconciliation. No additional Sorftime/SellerSprite collection was triggered. The first fingerprint mismatch occurred before the model audit was created.

Data-quality limitation inherited from the existing normalizer: missing rating/review-count metadata uses zero sentinels in the stored schema, and motive importance stars are model-derived. Neither represents measured source data. Missing positive/negative mention counts and proportions remain unavailable. This repair does not establish a newly generated business analysis report or live acceptance for other marketplaces.

An existing PostgreSQL store unit test still fails its SQL-text expectation for normalization locking. The same failure was reproduced on unchanged base 454c8279: expected MAX-based SQL differs from the implemented NOT EXISTS successor query. This is recorded separately, not counted as a passing full suite.

Before formal release, have the user review this candidate and decide whether to address the inherited metadata/importance representation alongside this import repair. Then deploy the committed build and migration together with a rollback record. Application rollback must disable non-US imports while preserving already stored records.
