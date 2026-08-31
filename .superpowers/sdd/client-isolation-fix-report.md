# Production client isolation fix report

## Outcome

The production client bundle no longer contains `ownerOrganizationId`, `sourceHeadsHash`, the legacy VOC module name, the fixed tenant sentinels, or any dynamically selected raw legacy report sentinel. The principal-scoped legacy-project eligibility endpoint still validates ownership on the Agent service and still validates its public response with a strict Zod schema, but it no longer returns the tenant owner identifier.

## Root cause and import chain

- Existing browser code reaches `shared/agent-contracts.ts` through runtime imports such as `app/page.tsx -> app/use-manual-alexa-voc.ts`, `app/asin-sync-funnel.tsx`, and `app/lib/local-agent-browser.ts`.
- The production bundle retains top-level Zod schema declarations from that shared module. The minified page chunk contained the complete project-contract declaration block around `LegacyProjectEligibilityResponseSchema`.
- Commit `5510c360ac18223022ffe766b28173e865ad5bcc` introduced `LegacyProjectEligibilityResponseSchema.ownerOrganizationId` into this already client-reachable shared module. This was the only fixed forbidden sentinel present after a fresh build; raw legacy report sentinels remained absent.
- The working Manual Alexa VOC pattern keeps ownership and source-hash fields in server-only manifest/projection schemas while public response schemas expose only safe projections. The eligibility response now follows that pattern.

## TDD fix

RED was observed twice before implementation:

1. A fresh `npm run build` followed by `node --test tests/manual-alexa-voc-client-bundle.test.mjs` failed because the client page chunk contained `ownerOrganizationId`.
2. The real Agent route integration test was changed to require the principal-scoped public eligibility response to omit the tenant owner field, then failed on the existing extra field.

The single behavioral fix removes `ownerOrganizationId` from the public eligibility response contract and payload. Ownership checks remain unchanged inside `LegacyProjectOwnershipService`; the web server now trusts only a successful, strictly validated response from that authenticated principal-scoped endpoint instead of rechecking a tenant identifier returned over the API.

## Files

- `shared/agent-contracts.ts`
- `server/services/legacy-project-ownership-service.ts`
- `app/lib/comparison-project-server.ts`
- `tests/agent/comparison-project-contract.test.ts`
- `tests/app/comparison-project-api.test.ts`
- `.superpowers/sdd/client-isolation-fix-report.md`

## Verification

- PASS: `npm run build`
- PASS: `node --test tests/manual-alexa-voc-client-bundle.test.mjs` (2/2)
- PASS: 70/70 affected client response, Manual VOC, comparison-project, stage-output, traffic-snapshot, saved-report, auth, and local-Agent browser tests
- PASS: scoped ESLint for all changed TypeScript/test files
- PASS: `git diff --check` for the task-owned diff
- PASS: direct scan of fresh `dist/client` artifacts returned zero matches for all five fixed forbidden strings
- BASELINE FAIL: `npx tsc --noEmit` reports many pre-existing integration errors, including generated WIP data shape mismatches, Cloudflare ambient types, and sync repository interface drift; none point to the task-owned files
- BASELINE FAIL: repository-wide `npm run lint` reports 219 errors and 7,865 warnings in unrelated existing/generated files; scoped lint is clean
- BASELINE FAIL: `tests/agent/contracts.test.ts` is 16/17 because its expected route registry predates three already-present routes (`GET /v1/projects`, `PATCH /v1/projects/:projectId`, and the legacy eligibility route)

The original 15 generated WIP files and `data/projects/ae7c9926-fba6-4d50-9afe-87d9a0fd638a.json` remain unstaged and unmodified by this task. No environment, deployment, process, browser, provider, or network mutation was performed.

## Commit

Atomic commit subject: `fix(voc): keep legacy owner identity server-only`. The resulting hash is reported in the task handoff because a commit cannot contain its own final hash.
