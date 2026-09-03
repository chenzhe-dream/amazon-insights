# Project Registration Idempotency Design

## Goal

Allow a newly created local analysis workspace to register through `POST /v1/projects` without weakening the Agent contract or creating duplicate projects.

## Design

- Keep `ProjectCreationIdempotencyKeySchema` mandatory and unchanged.
- Send `Idempotency-Key: project-register:<project UUID>` from the existing browser registration request.
- Derive the key only from the already-created local project ID so repeated clicks for the same workspace reuse the same key, while different workspaces use different keys.
- Keep the current fail-closed order: local workspace → formal project registration → sync submission. Registration failure must continue to produce zero sync jobs and zero Provider calls.
- Do not change project schemas, PostgreSQL data, sync lifecycle, Provider readiness, or retry behavior.

## Verification

- Browser regression proves the registration request carries the exact deterministic header.
- Existing double-click test still proves one registration and one sync request.
- Existing registration-failure tests remain fail-closed.
- Run the affected test file and one production build before deployment.
