# Review percentage semantics verification — 2026-09-10

## Outcome

- Review-derived rows now carry `review_sample_incidence` with explicit matched-review numerator and sampled-review denominator.
- Customers Say rows carry `customers_say_topic_share` with explicit topic mention numerator and total-topic-mentions denominator.
- Legacy rows without provenance remain readable and are labeled unknown; deterministic VOC preprocessing emits them as presence-only with no `mentionPct`.
- Customers Say-only ready records may have `sampledReviews: 0`; measured review incidence still requires a positive denominator equal to the parent sample count. The UI validates the complete tuple and downgrades mismatches to unknown.
- Review bars use a fixed 0–100 scale. Chinese visible guidance and hover text explain source, numerator/denominator, and overlapping topics.
- Positive/negative Customers Say blocks require the corresponding dominant polarity. Unmet-needs rows require negative evidence; broad `report` and positive `dimming` text no longer fabricate candidates. Zero/missing topic counts produce no invented denominator.

## TDD red evidence

Before production edits:

```text
node --test tests/scripts/review-percentage-semantics.test.mjs
0 passed, 3 failed: missing metric provenance; mixed polarity leaked into sentiment; broad report fabricated unmet need.

npx tsx --conditions=react-server --test tests/agent/review-percentage-rendering.test.ts
failed at module load because reviewMetricExplanation did not exist.
```

Additional red cases were observed before their fixes:

```text
positive dimming text without negative evidence: expected [], received an unmet row
zero Customers Say mentions: expected no provenanced row, received denominator 1
ratio mismatch: snapshot schema accepted sharePct 90 with numerator 1 / denominator 4
PostgreSQL exact-decimal rounding disagreed with JavaScript at 3 / 20000 (0.02 vs 0.01)
```

## Fresh green verification

```text
node --test tests/scripts/review-percentage-semantics.test.mjs tests/scripts/sorftime-review-verified-empty.test.mjs
18 passed, 0 failed

npx tsx --conditions=react-server --test tests/agent/review-percentage-rendering.test.ts tests/agent/voc-review-display.test.ts tests/agent/voc-review-runtime.test.ts tests/agent/voc-review-snapshot.test.ts tests/agent/voc-review-page-integration.test.ts tests/agent/voc-deterministic-preprocessing.test.ts tests/agent/analysis-agent-eval-set.test.ts
45 passed, 0 failed

npx tsx --conditions=react-server --test --test-name-pattern "migrations migrate a fresh database once" tests/agent/postgres-migrations.test.ts
1 passed, 0 failed; migration 29 applied and re-ran cleanly

npx tsx --conditions=react-server --test --test-name-pattern "SQLite migrations are recorded once|separate worker threads can concurrently migrate|SQLite 0014 preserves|version one databases upgrade" tests/agent/repository.test.ts
4 passed, 0 failed
```

The page integration test renders the actual matrix in Chromium and asserts the Chinese tooltip plus a 24.24% CSS width for a 24.24% row.
The final focused rerun also passed 4/4 rendering/schema checks, 5/5 transform checks, and the fresh/reentrant PostgreSQL migration test. PostgreSQL accepts only a 0.0050001 rounding tolerance around the evidence ratio, covering JavaScript half-cent behavior without accepting material drift.

Direct persistence coverage was added for both adapters. SQLite repository and raw-trigger tests accept legacy 3-field rows, explicit 6-field incidence rows, and Customers Say-only records with zero sampled reviews; partial provenance, arithmetic mismatch, and parent-denominator mismatch are rejected. PostgreSQL raw inserts cover the same matrix plus the JavaScript 3/20000 rounding boundary.

## Files changed for Task 1

- `scripts/lib/sorftime-review-transform.mjs`
- `scripts/lib/review-analysis-aggregate.mjs`
- `app/seller-sprite-review-analysis.ts`
- `app/page.tsx`
- `server/data/voc-data-snapshot.ts`
- `server/domain/voc/preprocess-voc-snapshot.ts`
- `server/db/migrations/0029_review_metric_provenance.sql`
- `server/db/migrations/postgres/0029_review_metric_provenance.sql`
- Review, preprocessing, evaluation-set, repository, and migration tests listed in the verification commands.

## Limitations

- Stored production rows were not rewritten. They intentionally render as unknown until refreshed with explicit provenance.
- No provider calls, production data changes, restart, deployment, staging, or commit were performed.
- Full repository `tsc --noEmit` remains non-green from existing unrelated type errors. The filtered output contained no new errors in the new review transform, schema, preprocessing, migration, or rendering tests; `app/page.tsx` and the evaluation set still report unrelated pre-existing errors outside this percentage change.
