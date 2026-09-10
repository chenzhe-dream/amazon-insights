# VOC all-step timeout implementation plan

**Goal:** Apply the existing default 300000 ms deadline to queued, running, retrying and publication-recovery work in alexa-voc-normalization, voc-positioning and product-definition.

**Architecture:** Keep the existing independent five-second sweeper and transactional job/lease settlement. Use the initial attempt's createdAt in each retry chain; automatic retries and lease recovery do not reset the deadline. Manual retry and newly submitted ASIN chains remain independent. Claim fencing, worker heartbeat and final settlement also check expiry. Preserve raw inputs, immutable audits, revisions, snapshots and reports; do not create fictitious success or delete history.

**Constraints:** No unrelated traffic/sync changes. Preserve user cancellations and completed tasks. Expiring an older normalization chain must not fail a newer active chain. No direct production status SQL, forced restart or unbounded retries. Database unavailable remains an infrastructure failure, not claimed successful cleanup. The five-minute bound has at most one sweeper/heartbeat scheduling interval under healthy DB conditions.

**Design approval:** User explicitly requested all VOC steps, following the proposed timeout-and-preserve-data design; prior instruction permits self-reviewed implementation without repeated confirmation. Use existing isolated worktree at a08f537. No UI design change beyond truthful timeout wording.

## Steps

- [x] Add dual-adapter tests for all three stages, running lease revocation, publication/audit preservation, independent newer normalization work and retry-chain deadline continuity; observe RED.
- [x] Extend shared expiry predicates and transactional settlement in both stores. Stop all eligible older normalization chains without modifying historical completed jobs. Derive aggregate stage status from remaining runnable work.
- [x] Propagate the existing timeout configuration to normalization/product workers; heartbeat and post-handler checks revoke overdue work even if a provider ignores abort. Verify late settlement cannot overwrite timeout.
- [x] Update Chinese deadline wording and replace obsolete tests that deliberately exempted publication forever. Test manual retries, no-model configuration, cancellation and PostgreSQL transaction races.
- [x] Independently review, run targeted full suites/build, document limitations and commit. Only after validated expiry is available, perform the already requested controlled release using preserved data and normal manager gates. Completed: 223/223 tests, independent approval, controlled formal release of 97f74e4; see verification report.

## Review-driven refinements

- Migration 0030 persists a manual-retry deadline anchor and normalization input-to-origin-job ownership. Automatic retries inherit their origin; only an explicit manual retry or new input receives a fresh deadline.
- Queue deduplication, runtime preparation/finalization, publication recovery and status reads use input ownership. A new ASIN cannot revive an expired sibling input or inherit its error/deadline.
- Existing shared input batches are backfilled to existing origins during migration; future origins are not implicitly linked to old inputs. Actual 0029-to-0030 upgrades are tested in both adapters.
- Completing one normalization job leaves the stage runnable while another sibling remains pending, so timeout cleanup continues to cover it.
- Review also checks sparse stage ordinals: sibling ASIN submissions must not consume another chain's retry budget.
