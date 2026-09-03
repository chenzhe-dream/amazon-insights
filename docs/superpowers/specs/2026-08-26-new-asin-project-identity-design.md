# New ASIN Project Identity Design

## Problem and invariant

The current analysis flow may patch the ASIN set of an existing local project and then reuse that project's ID in `POST /v1/projects`. PostgreSQL treats a project's marketplace and ASIN set as an immutable identity contract, so registration returns `409` and the subsequent sync POST is never sent. The UI currently makes this failure look like no action occurred.

Historical identity is immutable: an existing local project, PostgreSQL project, run, snapshot, and report must continue to refer to the ASIN set with which they were created.

## Chosen approach: create a new project identity

Before registration, compare the normalized input ASIN set and marketplace with the currently selected project's registered identity. If either differs, the flow must not patch or reuse the current project. It creates one new local analysis project with a new ID and slug, registers that same ID and exact ASIN set in PostgreSQL, switches the URL and client ownership to the new project, and only then permits one `POST /v1/local-data/sync-asins`.

The old local JSON, PostgreSQL project, current run, snapshots, and reports remain unchanged. Matching ASIN sets continue to reuse the matching project rather than creating duplicates.

### Rejected alternatives

- Updating the existing PostgreSQL project's ASINs is rejected because it changes the meaning and ownership of historical runs.
- Treating project-registration `409` as an upsert, success, or ignorable response is rejected because it hides a scope conflict and can attach a sync job to the wrong project identity.

## Data flow and ownership

1. Normalize and validate the entered marketplace and ASIN set.
2. Resolve the currently selected local project and its registered identity.
3. If the identity matches, retain the existing project. If it differs, atomically obtain or create one local project identity for the normalized request.
4. Register the selected identity through `POST /v1/projects` and require the response project ID, organization, marketplace, and ASIN set to match exactly.
5. After successful registration, switch the application URL, current project, and terminal/sync ownership to the selected project.
6. Admit exactly one sync POST scoped to that project. No sync POST is allowed before registration and ownership switching succeed.

Concurrent clicks share one in-flight operation keyed by organization, marketplace, and normalized ASIN set. The local create path must deduplicate that identity, and the existing UI in-flight guard must prevent a second registration or sync dispatch. A double click or concurrent equivalent request therefore produces one new project and one sync POST.

## Error behavior

Project creation or registration failure stops the pipeline before sync admission. The UI displays the fixed Chinese message `项目登记失败，未创建分析任务，请重试`. It retains the entered ASINs for correction or retry but does not mutate the old project, navigate to an unregistered project, or silently suppress the error.

The Web boundary continues to expose only fixed safe error codes and messages. Cookies, headers, credentials, provider bodies, and database details are never projected to the browser.

## Acceptance tests

- From an existing project, entering three different new ASINs creates a new local ID and slug, registers the same ID and exact ASIN set in PostgreSQL, switches the URL, and emits exactly one sync POST.
- The prior local project JSON raw hash is unchanged, and the PostgreSQL project identity plus all prior run, snapshot, and report records are unchanged.
- A project-registration `409` shows the fixed Chinese registration error and emits zero sync POSTs.
- Double click and concurrent equivalent submissions create one project identity and emit one sync POST.
- Refreshing the new slug restores the new project and its exact ASIN set.
- Cross-tenant behavior and authorization boundaries remain unchanged; a project from another organization cannot be resolved, reused, patched, or registered.

## Scope

This change is limited to local project identity selection/creation, PostgreSQL project registration ordering, URL/client ownership switching, deterministic error projection, and their tests. It does not change Provider integrations, connector readiness, Workers, stage outputs, retries, database schema, historical project records, or task lifecycle semantics.
