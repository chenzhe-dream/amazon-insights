# Manual Alexa VOC ASIN Binding Design

## Goal

Allow free-form Alexa VOC reports to enter deterministic parsing or LLM normalization without rejecting ordinary words or competitor ASINs, while keeping every import and response bound to the ASIN selected when the user submits.

## Scope

- Change only Manual Alexa VOC report identity handling, its user-facing advisory, and focused tests.
- Do not change the sync pipeline, Sorftime, SIF, image analysis, project hydration, provider configuration, or database schema.
- Do not make live provider requests while implementing or verifying the change.

## Decision

The selected ASIN captured by `createAlexaVocImportSubmission` is the authoritative write target. Raw report ASINs are advisory metadata, not a server-side rejection condition.

The UI may identify a primary report ASIN only from an explicit `ASIN:` label or a parenthesized ASIN in the opening report title. A candidate must be ten alphanumeric characters and contain a digit, so ordinary words such as `brightness` cannot be classified as ASINs. ASINs appearing later in competitor comparisons are ignored.

When the detected primary report ASIN differs from the selected target, the form displays a visible warning explaining that submission will write to the selected target. The warning does not disable the import button; clicking the button is the user's confirmation.

## Data Flow

1. The user selects an ASIN and pastes a report.
2. The client computes a non-blocking primary-ASIN advisory from the opening report lines.
3. On click, the existing submission helper snapshots `projectId`, `runId`, selected `asin`, and text together.
4. The server authorizes that immutable project/run/ASIN scope but does not compare it with arbitrary raw-text tokens.
5. Deterministic parsing runs first; incomplete free-form content is queued for LLM normalization.
6. Both deterministic and normalized records use the captured target ASIN.
7. The existing response-scope guard rejects any response whose ASIN differs from the captured submission ASIN, preventing cross-column backfill.

## Error Handling

- Raw-text ASIN differences no longer produce HTTP 422.
- Invalid request shape, report-size limits, authorization, cancelled runs, and unavailable normalization configuration retain their current behavior.
- Existing response-ASIN mismatch protection remains mandatory.
- The obsolete generic 422 copy must no longer claim that three standard headings are required for LLM-backed imports.

## Verification

Focused automated tests must prove:

- `brightness` produces no ASIN advisory and imports without a mismatch rejection.
- A matching title ASIN produces no warning.
- A different title ASIN produces a non-blocking warning while the submission remains bound to the selected ASIN.
- An explicit different ASIN can be queued and normalized under the selected target.
- The renderer emits the selected target ASIN even when raw text mentions another ASIN.
- Existing selected-card draft, response-scope, polling, and cross-column protections continue to pass.

Run only local deterministic tests, changed-file lint, one production build, diff checks, and formal-stack health checks. Do not call a real LLM/provider or submit a real VOC report during verification.
