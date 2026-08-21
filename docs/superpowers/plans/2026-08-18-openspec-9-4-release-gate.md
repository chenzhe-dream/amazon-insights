# OpenSpec 9.4 Release Gate Plan

## Goal

Complete only OpenSpec 9.4. A VOC agent candidate may become the public primary result only when one closed release evaluation proves complete automatic and human coverage, an immutable approved decision is persisted, an `agent-primary` mode event references that exact decision and candidate digest, and the selected report provenance still matches the approved candidate.

Do not add migrations, HTTP/admin routes, UI wiring, authentication, deployment, provider calls, or automatic rollout.

## Closed release evaluation

Create a versioned release-candidate envelope containing organization, module, Skill provenance, model provenance, and evaluation-set version. Derive its identity with canonical JSON SHA-256. The persistence boundary accepts only the five raw case outputs/observations and five persisted rating IDs; it reruns the production automatic evaluator and derives status, failure codes, and digests itself. It never accepts caller-computed automatic results or a caller-computed decision.

Approval requires:

- exactly one automatic result for each of the five frozen cases;
- every result uses the frozen evaluation-set version and carries the exact candidate digest;
- every result contains exactly the nine closed gate IDs, once each;
- every gate passes with an empty `ruleIds`, and the result itself passes;
- exactly one immutable human rating for each frozen case, with unique rating and report IDs;
- every rating belongs to the same organization, module, Skill, model, and evaluation-set candidate identity;
- every one of the six dimensions scores at least 4. Do not use averages.

Return stable candidate, automatic-result, and human-rating digests plus closed ordered failure codes. Reordering equivalent inputs must not change the result.

## Immutable decision and mode persistence

Reuse `audit_events` for approved and rejected release decisions. In one immediate transaction, read the five rating events by exact ID and organization, rerun the frozen production evaluator, derive the decision, then persist the complete candidate provenance, all three digests, rating IDs, failure codes, actor, and timestamp. Do not expose a direct arbitrary-decision append, and do not update or delete history.

Extend module modes with `agent-primary`. Such an event must include `releaseDecisionId` and `candidateDigest`. The SQLite repository must, in one immediate transaction, require an active same-organization actor and an existing same-organization approved decision with the exact module, decision ID, and candidate digest before inserting the mode event. Missing, rejected, corrupt, cross-organization, or mismatched decisions must leave mode history unchanged. `legacy-primary` rollback requires no release decision and takes effect by append order.

## Fail-closed result selection

The pure selector may expose a complete, fully parsed saved analysis report as public primary only when the strict resolved mode, approved decision, candidate envelope/digest, report module/Skill/model provenance, and the formal VOC positioning output shape all match. Provider and model identify provenance; a report response ID remains allowed. Any missing, empty, wrong-kind, malformed, rejected, mismatched, default, or read-error input selects legacy. `agent-shadow` retains only a valid formal VOC comparison while legacy remains public.

## Verification

Follow RED-GREEN for release evaluation, persistence, and selection. Then run focused evaluation/repository tests, related 9.1-9.3 regressions, one full Agent suite, normal build/render tests, Skill validation, strict OpenSpec validation, and `git diff --check`. Only after all required gates pass, check only task 9.4 and create a normal new commit.
