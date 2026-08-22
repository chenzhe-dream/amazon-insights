# Help and Feedback Center Integration Plan

> **Execution:** Use subagent-driven development, one implementation task at a time, followed by one limited independent review. Track every RED/GREEN/build result in `.superpowers/sdd/feedback-integration-report.md`.

**Goal:** Port the complete help and feedback center onto the current concurrency candidate without regressing resumable sync, PostgreSQL queueing, provider permits, quotas, or administrator controls.

**Baseline:** `98e9c36` on `codex/stabilize-resumable-sync-pipeline`. The old detached feedback worktree is reference material only; do not merge or cherry-pick its HEAD.

**Architecture:** Add strict shared contracts, an image sanitizer, storage-neutral repository methods, equivalent SQLite/PostgreSQL migration `0014`, narrowly bounded multipart/binary proxy support, Fastify routes that derive tenancy and authority from the authenticated principal, and a React drawer mounted in the left sidebar.

**Dependencies:** Pin `@fastify/multipart` to `9.2.1` and `sharp` to `0.34.5`, matching the proven old implementation and current lockfile ecosystem.

## Global constraints

- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline`; use absolute paths and verify both this worktree and the primary/shared worktree before every commit.
- Do not alter migrations `0001` through `0013`; create complete SQLite and PostgreSQL `0014_help_feedback_center.sql` files.
- Do not push, deploy, change provider concurrency, call real providers, read credentials, output database URLs, or touch ports `31900`, `31901`, `58258`, or `3000`.
- Use test-owned random ports for browser/integration tests. Do not use live data or live sessions.
- Follow RED-GREEN-REFACTOR. Commit only exact task paths; never use reset, clean, stash, rebase, amend, or `git add .`.
- Lists must never load image bytes. Images remain BLOB/BYTEA and are served only through separately authorized endpoints.
- Primary administrator means `role=admin` and normalized email exactly `admin@example.com`; an ordinary admin has member-level feedback access only.
- Each feedback accepts at most three sanitized PNG/JPEG/WebP images, each at most 5 MiB after sanitization. Submission is multipart, never JSON Base64.

---

### Task 1: Add immutable dual-database migration 0014

**Files:**
- Create `server/db/migrations/0014_help_feedback_center.sql`
- Create `server/db/migrations/postgres/0014_help_feedback_center.sql`
- Modify `server/db/migrate-sqlite-to-postgres.ts`
- Modify `tests/agent/repository.test.ts`
- Modify `tests/agent/sqlite-migrations.test.ts`
- Modify `tests/agent/postgres-migrations.test.ts`
- Modify `tests/agent/sqlite-to-postgres-migrator.test.ts`

- [ ] Add failing tests for fresh migration, reopen/checksum, historical `user_feedback` backfill, immutable events, transaction rollback, and SQLite-to-PostgreSQL copy order. Assert the new applied version is 14 while existing checksums remain unchanged.
- [ ] Run the four migration test files and capture RED caused by missing 0014.
- [ ] Add semantically equivalent workflow, immutable event, and attachment tables with tenant indexes, deterministic backfill, SQLite BLOB, and PostgreSQL BYTEA.
- [ ] Extend the migrator for the three new tables and parameterized binary copying.
- [ ] Rerun the same tests to GREEN, run `git diff --check`, stage only the listed paths, and commit `feat: add feedback center storage schema`.

### Task 2: Add image sanitization and transactional repositories

**Files:**
- Create `server/services/feedback-image-service.ts`
- Create `tests/agent/feedback-image-service.test.ts`
- Modify `server/db/repository.ts`
- Modify `server/db/sqlite-repository.ts`
- Modify `server/db/postgres/core-store.ts`
- Modify `server/db/postgres-repository.ts`
- Modify `tests/agent/feedback.test.ts`
- Modify `tests/agent/postgres-core-repository.test.ts`
- Modify `package.json`
- Modify `package-lock.json`

- [ ] Add failing sanitizer tests for valid formats, forged declarations, corrupt images, raw/sanitized size, pixel limits, metadata removal, normalized filename, and SHA-256.
- [ ] Add failing repository tests for atomic create, own/admin scope, cross-user/tenant denial, metadata-only list/detail queries, isolated blob reads, idempotent mark-seen, CAS status changes, and immutable history.
- [ ] Pin `sharp@0.34.5`; implement magic/decode/pixel checks, orientation normalization, metadata-free re-encoding, and final size enforcement.
- [ ] Implement equivalent SQLite and PostgreSQL aggregate transactions. Any attachment failure must leave all four feedback tables unchanged.
- [ ] Rerun only the affected sanitizer/repository tests to GREEN, run `git diff --check`, stage exact paths, and commit `feat: persist secure feedback attachments`.

### Task 3: Add strict contracts, authorization, and feedback routes

**Files:**
- Modify `shared/agent-contracts.ts`
- Modify `server/auth/authentication-service.ts`
- Modify `server/auth/authorization.ts`
- Modify `server/app.ts`
- Modify `server/routes/feedback.ts`
- Modify repository files only where Task 3 contracts require it
- Modify `tests/agent/authentication-service.test.ts`
- Modify `tests/agent/auth-authorization.test.ts`
- Modify `tests/agent/contracts.test.ts`
- Modify `tests/agent/feedback.test.ts`
- Modify `package.json`
- Modify `package-lock.json`

- [ ] Add failing tests for normalized authenticated email; unauthenticated/member/ordinary-admin/primary-admin; cross-user/tenant concealment; own and admin list/detail/attachment; no GET side effects; explicit mark-seen; CAS status history; bounded multipart; safe errors; and existing rate-limit/path stripping behavior.
- [ ] Pin `@fastify/multipart@9.2.1`. Register explicit field/file/count/size bounds and sanitize every file before opening the repository transaction.
- [ ] Derive actor, organization, role, and email only from the authenticated principal. Never return caught exception details.
- [ ] Rerun only affected auth/contracts/feedback tests to GREEN, run `git diff --check`, stage exact paths, and commit `feat: expose feedback center workflows`.

### Task 4: Harden the same-origin proxy for multipart and binary

**Files:**
- Modify `app/api/agent/[...path]/route.ts`
- Modify `tests/agent/proxy.test.ts`
- Create `tests/agent/feedback-proxy-integration.test.ts`

- [ ] Add RED tests through the real same-origin proxy proving one bounded multipart submission reaches Agent without losing its boundary and an authorized attachment response streams intact with safe headers.
- [ ] Preserve existing JSON proxy limits and authentication. Special-case only the approved feedback POST multipart route and feedback attachment GET routes; reject other multipart/binary expansion.
- [ ] Run proxy unit and real integration tests to GREEN, run `git diff --check`, stage exact paths, and commit `fix: proxy feedback attachments safely`.

### Task 5: Port the left-sidebar drawer and attachment experience

**Files:**
- Create `app/help-feedback/help-feedback-drawer.tsx`
- Create `app/help-feedback/help-feedback-client.ts`
- Create `app/help-feedback/help-manual.tsx`
- Create `app/help-feedback/feedback-image-input.tsx`
- Create `app/help-feedback/feedback-types.ts`
- Create or reuse a static manual asset under `public/`
- Modify `app/page.tsx`
- Modify `app/globals.css`
- Modify `app/warm-theme.css`
- Create `tests/agent/help-feedback-ui.test.tsx`

- [ ] Add RED component tests proving the left-sidebar `帮助与反馈` entry appears above data-source status, the right floating feedback button is absent, and `返回顶部` remains.
- [ ] Add RED interaction tests for manual/submit/mine tabs, primary-admin-only management, badge, picker/drop/paste, three-image cap, preview/delete/per-file errors, multipart submission, own/admin workflows, and dirty-draft confirmation on every close path.
- [ ] Port capability-level UI from the old worktree while adapting it to the current page/auth/concurrency baseline. Do not overwrite current `app/page.tsx` wholesale.
- [ ] Run affected UI tests to GREEN, run `git diff --check`, stage exact paths, and commit `feat: add help and feedback drawer`.

### Task 6: Isolated browser acceptance and implementation gate

**Files:**
- Create `tests/agent/help-feedback-browser.test.mjs`
- Modify prior task files only when a failing acceptance test demonstrates a direct blocker
- Append `.superpowers/sdd/feedback-integration-report.md` (ignored evidence file)

- [ ] Run a test-owned browser stack on random ports. Do not intercept the same-origin feedback proxy. Cover left entry/right removal, four identities, picker/drop/paste, previews/removal, submission, own history, attachment rendering, admin filtering/unread/mark-seen/status history, and dirty-draft cancel/confirm.
- [ ] Fix only reproduced acceptance blockers with a failing regression first.
- [ ] Run one implementation-side final gate: affected feedback migration/repository/auth/contracts/proxy/UI/browser tests; the directly affected sync/concurrency/auth regression files; one fresh `npm run build`; and `git diff --check`.
- [ ] Verify the candidate worktree is clean and the primary/shared worktree has no feedback-integration markers or unintended changes. Commit any test-first acceptance fix as `test: verify help feedback center acceptance`.
- [ ] Report exact commits, pass counts, skips, build result, worktree evidence, and any deferred non-blocking items. Do not deploy or push.

## Independent limited review

After Task 6, a fresh reviewer performs exactly one review limited to:

1. this confirmed design and plan;
2. `98e9c36..HEAD` feedback-integration changes;
3. migration collision/checksum safety, tenant/actor/admin authorization, atomic attachment persistence, multipart/binary proxy boundaries, safe error handling, and preservation of the left-entry/right-removal behavior;
4. direct regressions to approved concurrency and resumable-sync contracts.

Only a reproducible Critical or direct acceptance-contract blocker permits one repair pass. Non-blocking Important/Minor observations go to deferred tasks and do not expand the review. Approval requires Critical = 0, all confirmed acceptance contracts green, one fresh build green, both worktrees verified, and no live/provider action.
