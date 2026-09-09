# Explicit analysis favorites: approved design and execution plan

## Goal and global constraints

The user approved separating analysis history from explicit team favorites, followed by tests and the existing controlled LAN release. Preserve the current theme. No cloud deployment or comparison-draft migration.

- Analysis creation, loading, refresh and ordinary edits never favorite implicitly.
- Default view: 已收藏. 历史项目 contains all analysis projects, including starred ones.
- Explicit ☆ 收藏项目 / ★ 已收藏 toggles server-backed organization-shared state. Unfavorite must not delete or rewrite project files, ASINs, run records, results or their timestamps.
- Existing 24 analysis projects have no explicit favorite provenance: retain them as history, initially unstarred. No project migration or backfill. Preserve the other project kinds and their workflows.
- Current-project control is disabled until an existing project is selected. Navigation to the library is a separate link.
- Save-as-new creates history only; label it clearly. Users star the saved project explicitly. Ordinary save/update cannot change favorite state.
- Server derives organization and actor from authenticated sessions. Reject anonymous access, malformed IDs, arbitrary request bodies, nonexistent/non-analysis projects. Never accept organization IDs from browser input.
- Storage: a separate record per organization/project under shared AGENT_DATA_ROOT/analysis-project-favorites. Atomic replacement; no global read-modify-write lost updates. Read operations never create directories or rewrite old data. Idempotent removal affects this sidecar only.
- Browser state is scoped by session identity; late responses from previous sessions must not reappear. Failed writes do not report success or hide projects. Refresh reads server truth.
- Root exclusively edits the checkout; parallel agents are read-only reviewers. Preserve all unrelated WIP and coordinate formal release with the OpenSpec task.

## Task 1: Persist explicit favorites and expose authenticated routes

Files: shared/analysis-project-favorite-contracts.ts; server/services/analysis-project-favorite-store.ts; server/routes/analysis-project-favorites.ts; server/app.ts; tests/agent/analysis-project-favorites.test.ts.

- [ ] RED: temporary-directory tests for empty/no-write reads, persistence across instances, team sharing/org isolation, idempotency, project byte preservation, invalid IDs, missing/wrong-kind projects and corrupt storage.
- [ ] Implement separate store and strict GET /v1/local-data/project-favorites, PUT/DELETE /v1/local-data/projects/:id/favorite. Register using existing agent auth/proxy hook. Successful writes return only projectId/favorited, list returns projectIds.
- [ ] GREEN: authenticated route tests cover member/admin, no session, anonymous-loopback, spoofed organization/body, and runtime-root selection. No calls to providers or formal DB.

## Task 2: Library and current-project controls

Files: app/use-analysis-project-favorites.ts; app/analysis-project-favorite-button.tsx; app/project-library-panel.tsx; app/page.tsx; tests/agent/analysis-project-favorites-ui.test.tsx; focused Vite harness under tests/agent/helpers.

- [ ] RED: render real components; history does not appear as favorites; explicit add/remove persists on remount; unfavorite sends only sidecar DELETE; loading/error/pending states; session switch fences late responses; other kinds unchanged.
- [ ] Implement one root-owned hook shared between current button and library; analysis-only tabs/counts and Chinese empty states. Keep original other-kind behavior. Save-as-new is clearly history-only.
- [ ] GREEN: browser component tests, existing local-data and related regression suites; production build.

## Task 3: Independent review and controlled formal release

Files: docs/verification/2026-09-10-explicit-analysis-favorites.md.

- [ ] Read-only independent specification/security/quality review; fix blocking findings and rerun focused tests.
- [ ] Record candidate commit, build evidence, active-work check, formal baseline and rollback reference. Back up formal pointer/config and all generated/project files with hashes.
- [ ] Fast-forward only the coordinated formal checkout, preserve 15 generated files, use manage-formal-stack.ps1 -PublishCode. Do not restart PostgreSQL or other worktrees.
- [ ] Verify Web/Agent artifact agreement, local and LAN health, auth rejection, existing project hashes/counts unchanged; record and hand off.
