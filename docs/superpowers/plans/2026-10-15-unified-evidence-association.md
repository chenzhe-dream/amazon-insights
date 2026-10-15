# Unified evidence association implementation plan

Goal: implement the user-approved effectiveness audit; candidate 32900 only, no acquisition or 31900 deployment.

Design: extract structured observations from authorized saved inputs. Match demand concepts to product titles/frozen labels and same-ASIN review evidence. Matching is an auditable lexical association, not purchase attribution or proof of unmet demand. Unknown concepts retain exact phrase matching; no category IDs in rules. Preserve all evidence and expose unmatched, conflicting and incomparable observations. Snapshot v1 remains readable without recalculation; new v2 snapshots include observations, decision and rule registry.

Implementation alternatives considered: concatenating summaries cannot resolve the audited gap; model-only synthesis adds cost and cannot enforce numeric provenance. Use deterministic scope/metric gates and explicit dictionary/exact matching, keeping unrecognized semantic links pending. No new model requests.

User approved this scope on 2026-10-15. Existing audit serves as approved design; no further permission required. Work is sequential in the existing owning worktree; concurrent plugin edits are excluded.

- [ ] RED: cross-category fixtures for evidence chains, opposite signals, missing fields, differing denominators, true conflicts, rare risk, old snapshots.
- [ ] Contracts and observation adapters: typed demand/product/review/metric observations with source identity, actual window, sample and unit.
- [ ] Rules: explicit matching, shared-ASIN paths, price coverage, missing-evidence reconciliation, conflicts and per-candidate actions; preserve independent findings.
- [ ] UI: overall outcome and candidates above original module details; separate counterevidence, gaps and rule/provenance disclosure.
- [ ] GREEN: targeted domain/adapter/browser/store suites, offline four-module flow, typecheck and clean build.
- [ ] Candidate: deploy clean commit to32900/32901, verify current and v1 history; record unchanged31900 identity and acquisition count.

Validation: 3 unrelated category families, different IDs/countries; no evidence substitution across scope. Supported and unsupported cases must produce meaningfully different outcomes. Costs and conversion remain unknown unless explicitly evidenced; no synthetic total score or profit estimate.
