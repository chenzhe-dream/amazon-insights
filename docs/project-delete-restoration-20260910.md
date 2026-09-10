# Shared project deletion restoration — 2026-09-10

Baseline: `4bb38d966787de7216ec4aae96a945a0c0a5a4f1`.

## Root cause and change

`4309c65` replaced the analysis project delete button with a favorite toggle for both library views. The delete handler remained but was unreachable. Neither the legacy Web DELETE route nor the Agent local project DELETE route enforced a trusted owner/organization boundary.

- Favorites retain explicit add/remove behavior; unfavorite only removes the team marker.
- History restores a separate administrator delete action with team-impact confirmation, pending state, visible errors, and success feedback. Cancellation sends no delete request; failure retains project and favorite state.
- Web DELETE validates the current Agent session and same-origin request, then proxies to the same Agent deletion route.
- Agent deletion requires an authenticated administrator and a trusted `findLegacyProjectOwnerBinding` matching their organization. It rejects supplied body/query fields and ignores spoofed role headers. Missing authorization provider, missing binding, and foreign binding fail closed before deleting anything. Free-text `createdBy` is never used as authority.
- Deleting another project removes its list entry. Deleting the current project clears its selection, ASIN input and run state, then performs a full navigation out of `/p/slug` to the library. This disposes the old page's asynchronous observers and removes old project/run/vocRun/syncJob URL pointers. Success feedback survives that navigation as a consumed query flag.

## Verification

Red phase: browser test timed out waiting for the missing administrator `删除项目` action. Authorization test observed member access where administrator-only was required.

Passed:

```
node node_modules/tsx/dist/cli.mjs --test tests/agent/analysis-project-favorites-ui.test.tsx
```

7 browser tests: explicit favorite/unfavorite, reload persistence, favorite failure, stale session response, save to history, other project kinds, delete confirmation/cancel/failure/success, current and noncurrent selection.

```
node node_modules/tsx/dist/cli.mjs --conditions=react-server --test --test-skip-pattern='analysis workspace and its sync funnel use the local Agent bridge' tests/agent/local-data-bridge.test.ts tests/agent/project-delete-route.test.ts tests/agent/project-delete-authorization.test.ts tests/agent/authenticated-web-mutation.test.ts tests/agent/analysis-project-favorites.test.ts tests/agent/auth-authorization.test.ts
```

47 tests passed. Agent HTTP tests cover administrator/member/anonymous, trusted/missing/foreign bindings and spoofed scope. Web route tests use mocked upstream responses and isolated temporary project files, including same-origin enforcement and upstream denial. They do not connect to a live database.

Targeted ESLint passed for changed component, API, server files and tests. `git diff --check` passed.

## Limits and integration risks

- Unbound historical files remain undeletable even for administrators. No bindings were created and no existing account/data permissions were modified. The explicit ownership policy needs separate product follow-up if unbound projects must become deletable.
- The restriction also protects the legacy endpoint used by non-analysis shared project kinds; those projects likewise require an administrator and trusted binding.
- The excluded existing source-text test searches for `vocRunIdFromSearch(searchParams.toString())`; baseline `4bb38d9` already uses `vocRunIdFromSearch(appSearch)`. The complete local-data test file therefore still has this unrelated failure.
- Full `tsc --noEmit --incremental false` fails with broad errors including sync publication types, repository interfaces, and worker globals. No full build success is claimed.
- `app/page.tsx` ESLint reports 9 errors and 8 warnings; the unchanged baseline file produces the same totals. These concern existing hooks/ref usage, outside the added callback.
- The main page's full-navigation cleanup was inspected; browser tests exercise the actual library component with a small current-project callback harness, not the complete production page lifecycle.
- Existing dependencies were reused by a local node_modules junction. No dependency upgrades, formal service changes, deployment, push, real project deletion, or real database writes were performed.
