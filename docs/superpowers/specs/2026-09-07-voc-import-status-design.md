# VOC import identity and truthful progress repair

Approved 2026-09-07. Base: d9d9d6e. Branch: codex/fix-voc-import-status-20260907.

## Evidence and scope

The submitted snapshot is bound to the selected ASIN, not automatically to an ASIN found in its text. One later submission selected B07R56PTMS while its primary report header named B0F18D9B5V. Full-width parentheses escaped the existing advisory. Preserve selected-ASIN authority and require explicit confirmation of an advisory mismatch.

The long B0CDW797MM result is a saved same-ASIN report from September 1, not a browser response for another ASIN. New normalization attempts became stuck after publication failure: queue reuse includes failed attempts with an already scheduled successor, whereas worker claims exclude them. Status currently remains pending without a per-snapshot terminal. Client polling can also stop silently after network/schema failures or before the exact committed revision is readable.

## Approved behavior

- Warn on a primary ASIN mismatch including Chinese parentheses; never silently retarget or hard-reject legitimate comparison text.
- Do not reuse superseded/unclaimable failed jobs. Show exhausted failures honestly while preserving live retries and exact-fingerprint success.
- Show selected ASIN and real submission/processing/applying/success/failure states, indeterminate waiting animation, elapsed time and recoverable polling errors. No invented percentages.
- Keep polling through publication/read lag until the exact fingerprint/revision is applied. Scope state to project/run/ASIN.
- Identify existing result version/capture time when new data is pending; never present old content as the newly completed result.
- Reproduce the initial durable-revision publication failure in isolated PostgreSQL and fix only a verified cause. Preserve persistence-before-publication and retry-without-provider behavior.

## Boundaries

No production data changes, automatic replay of submitted inputs, live provider calls, restart, deployment, push, role/auth changes, generated-data edits, or unrelated architecture changes. In particular never replay the wrong-target fourth snapshot. Coordinate final tested HEAD with the OpenSpec window before integration/release.
