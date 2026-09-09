# 西柚缺凭据与缓存恢复验证

Date: 2026-09-09. Status: in progress; no completion or activation claim yet.

## Scope and evidence boundaries

User authorized explicit private configuration followed by the cache fix and recovery, then user-operated new-ASIN testing. No main/GitHub changes, new charts, permissions changes or full live Provider analysis. Source worktree: fix-voc-import-status-20260907. Formal worktree: integrate-xydc-variant-20260905. Initial code commit: 675fbfd; initial live data artifact: b888afb3223ad1ae72c4f0c8f8089124607944f17ecd57f31ecc449990d4d6fa.

## Diagnosis

- Formal env and its pre-presence-activation backup both lacked XYDC_MCP_TOKEN. Windows User variable was present, current invoking process absent. Only presence booleans were printed.
- At 2026-09-09T01:56:31.986Z all three old family files were unavailable/NOT_CONFIGURED, parentAsin equaled inputAsin, children zero. The corresponding old-three-ASIN synchronization completed at 01:57:15.578Z.
- New test ASINs B01E6CX34C, B07Y4PJJR4 and B07WFC14VR had zero projects, synchronization jobs or submissions in the formal database at diagnosis time.
- Pure in-memory real-function reproduction: the same ready one-child cache became unavailable/zero-child when token was empty, with one destructive cache write; nonempty synthetic token retained ready identity. Both arms made zero provider calls.
- Existing annual order files were not removed. Family identity loss prevented matching those snapshots.

## Private configuration preparation

- Explicit missing-key RED precheck passed. Backed up the exact external config to runtime/backups/xydc-missing-token-20260909/formal-stack.env.before.
- Used apply_patch inside the shell process to append a token loaded from the existing Windows User variable without emitting its value. GREEN: exactly one token key, exact value equality, every original config line unchanged. Config is outside Git. No restart at this phase.

## Recovery provenance

Source: test-results/xydc-current-asins-20260908/preview-props.json and acceptance-report.json captured at 2026-09-08T07:23:47.060Z. Restoring the original fresh flag for hashing reproduces the exact pre-existing raw family hash recorded during that acceptance run. The restored serving copies will be marked stale and retain fetchedAt 2026-09-06T17:41:33.287Z; no freshness relabeling.

| Input | Parent | Children | Original family SHA-256 | Existing annual total |
|---|---|---:|---|---:|
| B07R56PTMS | B0B9S3D13G | 4 | 92bd0be10c00b6b7e26aa959c30eb8f13ee7299d46052782c18a47f6575848a0 | 5900+ |
| B0F18D9B5V | B0D9W22TTY | 7 | f14cdaa03ca0feda8a6ef4b367630af5a42cdece064875daed63a105bef65fb8 | 3750+ |
| B0CDW797MM | B0HCC8ZN3W | 10 | e903ec64767246cc6e626a49d97e9500aa5e7289e7c933a9750521e435ed9908 | 59450+ |

All three parse through the current family schema and match surviving annual snapshots by country/parent/full child set/window (2025-09 through 2026-08). Independent read-only recovery review confirmed the production order reader selects all three original snapshots when supplied these families. Four independent active-work counts were zero at preparation, to be rechecked before recovery and publication. No shared family changes have occurred yet.

## Code verification at 5b1c0ee

- Task commit 5b1c0eedde11947d2a86b767c8eb4c9437f0f512; independent spec and task-quality review PASS, no Critical/Important/Minor findings.
- Implementer captured expected RED (1 pass, 3 failures) then focused GREEN 4/4. Root independently reran variant/order-display/order-sync 55/55; runtime data/authorization/order 15/15; managed-stack checks 23/23; rendered variant/order UI 22/22.
- Changed-file ESLint and source production build passed. Existing Vite route/chunk warnings were observed, not suppressed.
- TypeScript baseline and current both have 339 diagnostics with identical sorted file/code/message hashes; no new diagnostic. This is not a full-repository typecheck-clean claim.
- Exact manager Read-StrictEnvFile/Assert-FormalConfig/Set-FormalEnvironment functions loaded the private external config; an inherited Node child reported token present and absolute coordination root. This is config propagation evidence, not a live Provider authorization test.

## Remaining gates

- [x] Code TDD and independent task review; whole-change release review remains below.
- [x] Source build, lint/type baseline and scoped integration verification.
- [ ] Exact dirty-file preservation across formal fast-forward.
- [ ] Current idle check, three-file backup, apply_patch recovery and order-file hash preservation.
- [ ] Guarded code publication and exact health/source/artifact verification.
- [ ] Runtime data read verifies three annual snapshots; new-ASIN analysis remains user initiated.
- [ ] Final evidence review and OpenSpec handoff.
