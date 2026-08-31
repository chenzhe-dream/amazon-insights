# VOC and Keyword Runtime Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan batch-by-batch. Use superpowers:test-driven-development inside every commit unit and superpowers:verification-before-completion before each batch acceptance claim. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the current Manual VOC/product-analysis runtime, deliver immutable comparison scope migration `0021`, then deliver strict run-scoped SIF keyword evidence migration `0022` without weakening tenant isolation, provenance, request accounting, client-bundle safety, or existing WIP.

**Architecture:** Batch 0 restores a truthful runtime baseline and makes product analysis consume an explicit Manual VOC + keyword input. Batches 1–2 establish `comparisonDraft` as the only editable ASIN state and freeze Agent project/run scope. Batches 3–7 build a strict SIF adapter, immutable evidence/receipt repository, bounded fallback runtime, id-only stage/API boundary, evidence-only UI/downstream projection, and independently reversible release gates.

**Tech Stack:** TypeScript 5.9, Node.js 22, React 19/Vinext, Zod 4, Fastify 5, SQLite/PostgreSQL repositories, Node test runner through `tsx --test`, ESLint, existing stable-build transaction.

## Global Constraints

- Worktree: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline`.
- Planning baseline: `a5d233bdfe977fb33d814b79a89352d567d3d6c5`. Before implementation, run `git rev-parse HEAD` and stop if it is neither this SHA nor the recorded acceptance commit from the immediately previous batch.
- The worktree already contains user-owned generated/live data and publication/project WIP. Never use `git add .`, `git add -A`, reset, checkout, clean, stash, rebase, amend or a destructive filesystem command. Every commit stages only the paths listed by its commit unit and prints `git diff --cached --name-only` before committing.
- Migration allocation is immutable: Plan 01 owns SQLite/PostgreSQL `0019_manual_alexa_voc` and `0020_voc_snapshot_per_asin_provenance`; Plan 02 owns `0021_comparison_project_scope`; Plan 03 owns `0022_keyword_evidence`. Do not rename, renumber, squash into an earlier migration, or create a competing `0021`/`0022`.
- Execution order is strict: Batch 0 → Batch 1 → Batch 2 acceptance → Batch 3 → Batch 4 → Batch 5 → Batch 6 → Batch 7. Plan 03 cannot start until Plan 02 has an immutable committed scope and both database engines have passed the real `0020 → 0021` upgrade.
- Manual VOC remains PostgreSQL-first, organization/marketplace/ASIN scoped, epoch-fenced and owner-gated for legacy reads. Any edit to `app/page.tsx` must preserve overlay clear-on-session/org-change, stale response rejection, exact revision/hash merge rules and the existing five independent Manual VOC flags.
- `KeywordEvidenceRepository` is the only runtime keyword authority after cutover. `app/sif-keyword-analysis-data.ts` and `app/sif-keyword-enrichment-data.ts` remain server-only migration/diagnostic inputs; they never become browser fallback, run fallback, export input or product-definition input.
- The production SIF capability manifest begins empty and fails closed. A real canonical/alternate/category operation may be enabled only by a separate human-reviewed commit containing an official-document or saved-and-sanitized `tools/list` contract, exact descriptor SHA-256 and manifest checksum. Unit fixtures use `allowTestFixtures:true` and cannot authorize production HTTP.
- Every target's SIF physical dispatches, including connector retries and all fallback levels, share a hard cap of 3. Every real fetch has one receipt; a waiter sends zero requests; handed-to-network requests consume even on timeout/4xx/5xx/unknown result; only proven-unsent reservations release.
- Parent/main Listing and category proxy evidence always retain target identity and lookup/category identity. Sorftime may verify relationship/category or add cross-validation facts, but cannot populate SIF target traffic share, rank, keyword count or target keyword rows.
- No implementation or focused test starts, stops or calls real 31900/31901/58258, Chrome/CDP, SIF, Sorftime, SellerSprite, OpenAI or Amazon. Use Fastify inject, temporary databases/directories and injected fake transports. Batch 7 may run the existing production build transaction, but does not start a listener.
- Current full-tree TypeScript status is a known failure, not a green gate: `npx tsc --noEmit --incremental false --pretty false` exits 2 with exactly 306 diagnostics at the planning baseline. The top categories are TS2322=110, TS2339=34, TS2353=32, TS2345=30, TS2769=15, TS7006=13, TS7053=12, TS2741=11, TS1117=9 and TS2554=8. Per-commit GREEN means focused tests + changed-path diagnostics=0 + scoped ESLint/diff-check. Batch 7 reruns full compiler/lint and classifies the baseline; it does not call known failures successful.

## Frozen Baseline Capture

- [ ] Before changing code, capture the exact dirty-worktree identity without staging it:

```powershell
git rev-parse HEAD
git status --porcelain=v1
$tscOutput = @(& npx tsc --noEmit --incremental false --pretty false 2>&1)
$tscExit = $LASTEXITCODE
$tscOutput | Set-Content -LiteralPath '.superpowers/sdd/voc-keyword-tsc-baseline.txt' -Encoding utf8
$tscDiagnostics = @($tscOutput | Where-Object { "$_" -match 'error TS\d+:' })
if ($tscExit -ne 2 -or $tscDiagnostics.Count -ne 306) { throw "Expected the documented exit-2/306 TypeScript baseline" }
```

  `.superpowers/sdd/voc-keyword-tsc-baseline.txt` is ignored execution evidence and must never be staged.

- [ ] Define this changed-path gate in each PowerShell execution shell. It runs the real compiler but fails only for listed affected paths:

```powershell
function ConvertTo-NormalizedTscDiagnostic([string]$Line) {
  $normalized = $Line.Replace('\\', '/')
  if ($normalized -match '^([^\(]+)\(\d+,\d+\): error (TS\d+): (.*)$') {
    return "$($Matches[1])|$($Matches[2])|$($Matches[3])"
  }
  return $null
}

function Assert-NoAffectedTypeDiagnostics([string[]]$Paths) {
  $baselinePath = '.superpowers/sdd/voc-keyword-tsc-baseline.txt'
  if (-not (Test-Path -LiteralPath $baselinePath)) { throw "Missing frozen TypeScript baseline" }
  $output = @(& npx tsc --noEmit --incremental false --pretty false 2>&1)
  $normalizedPaths = @($Paths | ForEach-Object { $_.Replace('\\', '/') })
  $baseline = @(Get-Content -LiteralPath $baselinePath | ForEach-Object { ConvertTo-NormalizedTscDiagnostic "$_" } | Where-Object { $_ } | Sort-Object -Unique)
  $current = @($output | ForEach-Object { ConvertTo-NormalizedTscDiagnostic "$_" } | Where-Object { $_ } | Sort-Object -Unique)
  $baselineAffected = @($baseline | Where-Object { $normalizedPaths -contains ($_ -split '\|', 2)[0] })
  $currentAffected = @($current | Where-Object { $normalizedPaths -contains ($_ -split '\|', 2)[0] })
  $introduced = @(Compare-Object $baselineAffected $currentAffected | Where-Object SideIndicator -eq '=>' | ForEach-Object InputObject)
  if ($introduced.Count -gt 0) {
    $introduced | ForEach-Object { Write-Error "$_" }
    throw "Introduced affected TypeScript diagnostics: $($introduced.Count)"
  }
  Write-Host "Introduced affected TypeScript diagnostics: 0; retained affected baseline: $($currentAffected.Count)"
}
```

## Batch Map and Hard Dependencies

| Batch | Work absorbed | Hard dependency | Acceptance boundary |
| --- | --- | --- | --- |
| 0 | Three current blockers + explicit VOC×keyword page model | HEAD `a5d233bd` | Product analysis no longer crashes, ordinary Node imports Agent composition root, latest migration assertion is 20 |
| 1 | Plan 02 Tasks 1–4 | Batch 0 acceptance | Pure draft + `0021` + principal routes + favorite/legacy owner gate |
| 2 | Plan 02 Tasks 5–8 | Batch 1 | One page draft owner, revision fences, hydrate/library, UI-only rollback flag; Plan 02 accepted |
| 3 | Plan 03 Tasks 1–3 | Batch 2 acceptance | Strict contracts/registry + `0022` + repository/stores; zero provider HTTP |
| 4 | Plan 03 Tasks 4–7 | Batch 3 | Receipt ledger + verified worker scope + canonical/retry + parent/category fallback |
| 5 | Plan 03 Tasks 8–9 | Batch 4 | Stage publishes only evidence ids; authenticated exact-set run-scoped GET |
| 6 | Plan 03 Tasks 10–11 plus omitted consumers | Batch 5 | UI/export/product definition share evidence projection; all static keyword client paths removed |
| 7 | Plan 03 Task 12 + release convergence | Batch 6 | Independent flags, observability, combined Manual+Keyword build/bundle gate, truthful full-baseline report |

---

## Batch 0: Repair the Current Runtime Baseline First

**Dependencies:** Exact planning HEAD and frozen 306-diagnostic capture. No migration changes.

**Files — product source commit:**

- Modify: `app/product-launch-analysis.ts`
- Modify: `app/product-launch-recommendation.tsx`
- Modify: `app/voc-positioning-section.tsx`
- Modify: `app/product-definition-section.tsx`
- Modify: `app/launch-checklist-section.tsx`
- Modify: `app/page.tsx`
- Modify: `tests/agent/voc-legacy-characterization.test.ts`
- Create: `tests/agent/voc-keyword-page-model.test.ts`

**Files — Node composition commit:**

- Create: `server/data/manual-alexa-voc-projection-store.node.ts`
- Modify: `server/data/manual-alexa-voc-projection-store.ts`
- Create: `server/services/manual-alexa-voc-publication-service.node.ts`
- Modify: `server/services/manual-alexa-voc-publication-service.ts`
- Create: `server/services/manual-alexa-voc-retention-service.node.ts`
- Modify: `server/services/manual-alexa-voc-retention-service.ts`
- Modify: `server/agent-service.ts`
- Modify: `tests/agent/voc-positioning-node-runtime.test.ts`

**Files — migration assertion commit:**

- Modify: `tests/agent/product-definition-runtime.test.ts`

**Interfaces:**

```ts
export type ProductLaunchRuntimeSources = Readonly<{
  manualVocByAsin: Readonly<Record<string, ManualAlexaVocNormalizedRecord | undefined>>;
  keywordDemand: KeywordDemandAnalysis | null;
}>;

export function buildProductLaunchAnalysis(
  products: readonly LaunchProductInput[],
  sources: ProductLaunchRuntimeSources,
): ProductLaunchAnalysis;

export function hasProductLaunchAnalysis(
  products: readonly LaunchProductInput[],
  sources: ProductLaunchRuntimeSources,
): boolean;
```

`keywordDemand` is computed by the page from its resolved keyword maps in Batch 0; Batch 6 changes that page computation to the run-scoped evidence view without changing the product-analysis function signature. Neither function has a default source argument.

- [ ] **Write the product-source RED tests.** Use a product with no usable static Alexa row, place its seven-dimension Manual record only in `manualVocByAsin`, and place its keyword only in explicit `KeywordDemandSources`. Assert launch, positioning, definition and checklist results include both signals. With `keywordDemand:null`, assert the documented keyword-not-ready/C-grade state instead of a throw. With an empty Manual map, assert a bounded missing-VOC model instead of `Object.entries(undefined)`.

- [ ] **Run product-source RED.**

```powershell
npx tsx --conditions=react-server --test tests/agent/voc-keyword-page-model.test.ts tests/agent/voc-legacy-characterization.test.ts
```

  Expected: current one-argument product-analysis calls fail with TS/runtime arity or explicit-source assertions.

- [ ] **Implement the explicit source composition.** `buildVocDevelopmentSummary` and `hasVocDevelopmentData` always receive `sources.manualVocByAsin`. `buildKeywordConclusions` receives `sources.keywordDemand` and never calls `buildKeywordDemandAnalysis` itself. `app/page.tsx` constructs one memoized `ProductLaunchRuntimeSources` from the current Manual overlay and the page-resolved keyword view, then passes the same object to all four product-analysis sections. Every component includes `sources` in its memo dependencies.

- [ ] **Write and run the ordinary-Node RED.** Keep the existing spawn without `--conditions=react-server`; add assertions that the three public `server-only` wrappers retain the marker and that `server/agent-service.ts` imports only `.node` implementations.

```powershell
npx tsx --conditions=react-server --test tests/agent/voc-positioning-node-runtime.test.ts
```

  Expected: `ordinary Node imports the production VOC composition root` fails at `node_modules/server-only/index.js`.

- [ ] **Split marked wrappers from Node implementations.** Move implementation bodies into the three `.node.ts` files. Keep each original path as exactly a marked server wrapper:

```ts
import "server-only";
export * from "./manual-alexa-voc-publication-service.node";
```

  Use the corresponding relative `.node` path in each wrapper. `server/agent-service.ts` imports `.node` implementations; `manual-alexa-voc-publication-service.node.ts` imports the projection `.node` implementation. Do not remove a safety marker or add React conditions to `agent:start`.

- [ ] **Repair the migration assertion under RED/GREEN.** In `tests/agent/product-definition-runtime.test.ts`, assert the actual fixed Plan 01 head `20`, not `9`, after all product report/run assertions. Do not make the assertion derive from the migration list under test.

- [ ] **Run Batch 0 GREEN and page probe.**

```powershell
npx tsx --conditions=react-server --test tests/agent/voc-keyword-page-model.test.ts tests/agent/voc-legacy-characterization.test.ts
npx tsx --conditions=react-server --test tests/agent/voc-positioning-node-runtime.test.ts
npx tsx --conditions=react-server --test tests/agent/product-definition-runtime.test.ts
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts tests/agent/manual-alexa-voc-rollback.test.ts
node --import tsx --conditions=react-server --input-type=module -e "const m=await import('./app/product-launch-analysis.ts'); const p=[{asin:'B0ALEXA001',brand:'Fixture',productFamily:'scooter'}]; const r=m.buildProductLaunchAnalysis(p,{manualVocByAsin:{},keywordDemand:null}); console.log(JSON.stringify({ok:true,keywordReady:Boolean(r.keywordConclusions)}));"
Assert-NoAffectedTypeDiagnostics @('app/product-launch-analysis.ts','app/product-launch-recommendation.tsx','app/voc-positioning-section.tsx','app/product-definition-section.tsx','app/launch-checklist-section.tsx','app/page.tsx','tests/agent/voc-legacy-characterization.test.ts','tests/agent/voc-keyword-page-model.test.ts','server/data/manual-alexa-voc-projection-store.node.ts','server/data/manual-alexa-voc-projection-store.ts','server/services/manual-alexa-voc-publication-service.node.ts','server/services/manual-alexa-voc-publication-service.ts','server/services/manual-alexa-voc-retention-service.node.ts','server/services/manual-alexa-voc-retention-service.ts','server/agent-service.ts','tests/agent/voc-positioning-node-runtime.test.ts','tests/agent/product-definition-runtime.test.ts')
```

  `app/page.tsx` retains five older URL/SearchParams diagnostics from the 306 baseline; the three product-launch TS2554 diagnostics must be gone. `tests/agent/product-definition-runtime.test.ts` may still expose its two pre-existing `RuntimeAgentRepository` assignability diagnostics, but the focused runtime test must pass.

- [ ] **Commit Batch 0 in three independently reviewable units.**

```powershell
git add -- app/product-launch-analysis.ts app/product-launch-recommendation.tsx app/voc-positioning-section.tsx app/product-definition-section.tsx app/launch-checklist-section.tsx app/page.tsx tests/agent/voc-legacy-characterization.test.ts tests/agent/voc-keyword-page-model.test.ts
git diff --cached --name-only
git commit -m "fix(product): compose manual VOC and keyword sources"

git add -- server/data/manual-alexa-voc-projection-store.node.ts server/data/manual-alexa-voc-projection-store.ts server/services/manual-alexa-voc-publication-service.node.ts server/services/manual-alexa-voc-publication-service.ts server/services/manual-alexa-voc-retention-service.node.ts server/services/manual-alexa-voc-retention-service.ts server/agent-service.ts tests/agent/voc-positioning-node-runtime.test.ts
git diff --cached --name-only
git commit -m "fix(agent): keep server-only wrappers out of node composition"

git add -- tests/agent/product-definition-runtime.test.ts
git diff --cached --name-only
git commit -m "test(product): align migration head assertion"
```

**Batch 0 gate:** No page crash; explicit Manual VOC and keyword inputs reach all four consumers; ordinary Node imports the production composition root without React conditions; wrapper safety markers remain; latest migration assertion is 20; no provider or live port was called.

---

## Batch 1: Plan 02 Foundation — Draft, Migration 0021, Principal Routes and Favorites

**Dependencies:** Batch 0 gate and no existing `0021` migration.

**Files:**

- Create: `app/lib/comparison-draft.ts`
- Create: `tests/web/comparison-draft.test.ts`
- Modify: `shared/agent-contracts.ts`
- Modify: `server/db/repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/db/postgres-repository.ts`
- Create: `server/db/migrations/0021_comparison_project_scope.sql`
- Create: `server/db/migrations/postgres/0021_comparison_project_scope.sql`
- Modify/Create: `tests/agent/comparison-project-contract.test.ts`
- Modify: `server/routes/analysis-runs.ts`
- Modify: `server/services/analysis-run-service.ts`
- Create: `server/routes/legacy-project-ownership.ts`
- Create: `server/services/legacy-project-ownership-service.ts`
- Create: `server/cli/bind-legacy-project-owner.ts`
- Modify: `scripts/lib/project-store.mjs`
- Modify: `server/app.ts`
- Create: `tests/scripts/project-store-readonly.test.mjs`
- Create: `scripts/lib/project-favorite-store.mjs`
- Create: `app/lib/comparison-project-server.ts`
- Create: `app/api/comparison-projects/route.ts`
- Create: `app/api/comparison-projects/[projectId]/route.ts`
- Create: `app/api/comparison-favorites/[projectId]/route.ts`
- Create: `tests/app/comparison-project-api.test.ts`

**Core contracts:**

```ts
type ComparisonDraft = Readonly<{
  slots: readonly string[];
  normalizedAsins: readonly string[];
  issues: readonly DraftIssue[];
  source: "empty" | "url" | "project" | "run" | "user";
  basedOnProjectId: string | null;
  dirty: boolean;
  revision: number;
}>;

type CommittedComparisonScope = Readonly<{
  organizationId: string;
  marketplace: "US";
  projectId: string;
  runId: string | null;
  asins: readonly string[];
  committedAt: string;
}>;

type ValidComparisonDraftSnapshot = Readonly<{
  marketplace: "US";
  asins: readonly string[];
  draftRevision: number;
}>;
```

- [ ] **RED the pure reducer.** Cover 0–10 slots, add/remove/replace/clear, trim/uppercase, invalid/duplicate diagnostics, legal 0–2 editing, all-or-nothing rejection of the eleventh item, frozen snapshots, and action-boundary 3–10 validation.

- [ ] **GREEN the reducer and commit B1.1.** Accepted actions create a frozen revision+1 value. An over-limit action preserves slots/normalized values/revision and only adds `{code:"too-many",attemptedCount}`.

```powershell
npx tsx --conditions=react-server --test tests/web/comparison-draft.test.ts
npx eslint app/lib/comparison-draft.ts tests/web/comparison-draft.test.ts
Assert-NoAffectedTypeDiagnostics @('app/lib/comparison-draft.ts','tests/web/comparison-draft.test.ts')
git add -- app/lib/comparison-draft.ts tests/web/comparison-draft.test.ts
git commit -m "feat(comparison): add immutable ASIN draft reducer"
```

- [ ] **RED migration/repository invariants.** Test fresh install and real `0020 → 0021` upgrade on both engines; organization-scoped project idempotency replay after reopen; same key/different canonical payload 409; same key across organizations isolation; immutable marketplace/ordered-ASIN patch rejection; active-user legacy owner binding.

  Migration `0021_comparison_project_scope` creates `project_creation_idempotency` keyed by `(organization_id,idempotency_key)` and `legacy_project_owner_bindings` keyed by `legacy_project_id`. Project and idempotency row commit in one transaction. `Idempotency-Key` accepts exactly 16–128 ASCII `[A-Za-z0-9._:-]`.

- [ ] **GREEN repositories and commit B1.2.**

```powershell
npx tsx --conditions=react-server --test tests/agent/comparison-project-contract.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
Assert-NoAffectedTypeDiagnostics @('shared/agent-contracts.ts','server/db/repository.ts','server/db/sqlite-repository.ts','server/db/postgres-repository.ts','tests/agent/comparison-project-contract.test.ts','tests/agent/sqlite-migrations.test.ts','tests/agent/postgres-migrations.test.ts')
git add -- shared/agent-contracts.ts server/db/repository.ts server/db/sqlite-repository.ts server/db/postgres-repository.ts server/db/migrations/0021_comparison_project_scope.sql server/db/migrations/postgres/0021_comparison_project_scope.sql tests/agent/comparison-project-contract.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
git commit -m "feat(projects): add immutable comparison scope migration"
```

- [ ] **RED/GREEN principal routes and commit B1.3.** `POST /v1/projects` parses the header before service invocation; list/get/metadata patch derive organization only from the principal; cross-tenant reads are indistinguishable 404; ASIN/marketplace bodies are strict-schema 400 and repository mutation is 409. The UUID-only `readProjectReadonly` never creates/enumerates/writes a directory or resolves a slug. Member reads never create legacy bindings; only authenticated operator route/CLI calls `bindOnce`.

```powershell
npx tsx --conditions=react-server --test --test-name-pattern="principal-scoped project|immutable project patch|run cutoff|legacy" tests/agent/comparison-project-contract.test.ts
node --test tests/scripts/project-store-readonly.test.mjs
Assert-NoAffectedTypeDiagnostics @('server/routes/analysis-runs.ts','server/services/analysis-run-service.ts','server/routes/legacy-project-ownership.ts','server/services/legacy-project-ownership-service.ts','server/cli/bind-legacy-project-owner.ts','server/app.ts','shared/agent-contracts.ts','tests/agent/comparison-project-contract.test.ts')
git add -- server/routes/analysis-runs.ts server/services/analysis-run-service.ts server/routes/legacy-project-ownership.ts server/services/legacy-project-ownership-service.ts server/cli/bind-legacy-project-owner.ts scripts/lib/project-store.mjs server/app.ts shared/agent-contracts.ts tests/agent/comparison-project-contract.test.ts tests/scripts/project-store-readonly.test.mjs
git commit -m "feat(projects): scope immutable projects to the principal"
```

- [ ] **RED/GREEN favorite-only Web layer and commit B1.4.** Persist only `{organizationId,agentProjectId,kind,slug,labels}` beneath organization-safe paths. The Web route forwards the client key byte-for-byte, verifies Agent echo before favorite creation, and never imports Agent repositories/legacy files. Favorite failure does not roll back the Agent project. Foreign/unowned legacy records return 404; visitor reads never bind ownership.

```powershell
npx tsx --conditions=react-server --test tests/app/comparison-project-api.test.ts
npx eslint app/lib/comparison-project-server.ts app/api/comparison-projects/route.ts app/api/comparison-projects/[projectId]/route.ts app/api/comparison-favorites/[projectId]/route.ts
Assert-NoAffectedTypeDiagnostics @('app/lib/comparison-project-server.ts','app/api/comparison-projects/route.ts','app/api/comparison-projects/[projectId]/route.ts','app/api/comparison-favorites/[projectId]/route.ts','tests/app/comparison-project-api.test.ts')
git add -- scripts/lib/project-favorite-store.mjs app/lib/comparison-project-server.ts app/api/comparison-projects/route.ts app/api/comparison-projects/[projectId]/route.ts app/api/comparison-favorites/[projectId]/route.ts tests/app/comparison-project-api.test.ts
git commit -m "feat(projects): gate legacy favorites by organization"
```

**Batch 1 gate:** Both engines upgrade from `0020` to `0021`; tenant 404, header idempotency, immutable scope, owner gate and favorite-only storage pass; Batch 0 Manual/product source tests remain green.

---

## Batch 2: Plan 02 Client Cutover, Fences, Hydration and UI Rollback

**Dependencies:** Batch 1 migrations/routes committed.

**Files:**

- Create: `app/lib/comparison-project-client.ts`
- Create: `app/comparison-project-library-panel.tsx`
- Create: `app/lib/comparison-draft-policy.ts`
- Create: `app/api/comparison-projects/config/route.ts`
- Modify: `app/page.tsx`
- Modify: `tests/agent/comparison-page-state.test.tsx`
- Modify: `tests/app/comparison-project-api.test.ts`
- Modify: `tests/web/comparison-draft.test.ts`
- Modify: `tests/agent/comparison-project-contract.test.ts`
- Create: `docs/superpowers/reports/2026-08-31-comparison-draft-asin-management-report.md`

- [ ] **RED the single owner.** Input edit, textarea paste, clear, URL draft, project hydrate and run hydrate may change only `comparisonDraft`. Save/run/sync/checklist/keyword/traffic actions must consume the same frozen snapshot. No new comparison action may call `/v1/local-data/projects` or `/api/projects`.

- [ ] **GREEN one client owner and commit B2.1.** `beginComparisonAction(snapshot)` creates one idempotency key; retry reuses it. Replace mutable `inputs`, `asinDraft`, `activeAsins` ownership with reducer state + `committedScope`. Preserve Batch 0 `ProductLaunchRuntimeSources`: recompute it from current Manual overlay and current resolved keyword demand, then pass it unchanged to all four consumers. Historical reports/progress remain bound to committed scope, never draft preview.

```powershell
npx tsx --conditions=react-server --test tests/agent/comparison-page-state.test.tsx tests/agent/voc-keyword-page-model.test.ts tests/agent/manual-alexa-voc-client-store.test.ts
npx eslint app/page.tsx app/lib/comparison-project-client.ts
Assert-NoAffectedTypeDiagnostics @('app/lib/comparison-project-client.ts','tests/agent/comparison-page-state.test.tsx','tests/agent/voc-keyword-page-model.test.ts')
git add -- app/lib/comparison-project-client.ts app/page.tsx tests/agent/comparison-page-state.test.tsx
git commit -m "feat(comparison): use one draft state for all ASIN actions"
```

  `app/page.tsx` may retain only its five frozen URL/SearchParams baseline diagnostics; no new page diagnostic is allowed.

- [ ] **RED/GREEN revision fences and commit B2.2.** A delayed create may create the old snapshot server-side but cannot mark a newer draft clean. A delayed run attaches only to the same committed project and unchanged action revision. Dirty history creates a new project; clean history may create a new run; every failure preserves current draft.

```powershell
npx tsx --conditions=react-server --test --test-name-pattern="revision fence|dirty draft|clean project|run scope" tests/agent/comparison-page-state.test.tsx tests/app/comparison-project-api.test.ts
git add -- app/page.tsx app/lib/comparison-project-client.ts tests/agent/comparison-page-state.test.tsx tests/app/comparison-project-api.test.ts
git commit -m "fix(comparison): fence project and run responses by draft revision"
```

- [ ] **RED/GREEN hydrate/library and commit B2.3.** Precedence is `project/run > draftAsins > legacy asins > empty`; 0–2 draft values survive; invalid/duplicates remain diagnostics; navigation token rejects old hydration. Legacy library is read-only with explicit import-as-new. Deleting favorite explicitly says it does not delete project/run/report.

```powershell
npx tsx --conditions=react-server --test --test-name-pattern="hydrate precedence|legacy library|navigation token" tests/agent/comparison-page-state.test.tsx
npx eslint app/comparison-project-library-panel.tsx app/page.tsx app/lib/comparison-project-client.ts
git add -- app/comparison-project-library-panel.tsx app/page.tsx app/lib/comparison-project-client.ts tests/agent/comparison-page-state.test.tsx
git commit -m "feat(comparison): separate draft URLs from committed history"
```

- [ ] **RED/GREEN the declared rollback flag and acceptance, commit B2.4.** `COMPARISON_DRAFT_UI_ENABLED` is default off and only exact `1` enables the reducer UI. The same-origin config response is strict `{comparisonDraftUiEnabled:boolean}` and exposes no tenant data. UI-off restores the legacy editor only; new Agent project creation, immutable scope, `0021` rows, committed runs and reports remain unchanged.

```powershell
npx tsx --conditions=react-server --test tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx
npx tsx --conditions=react-server --test tests/agent/voc-keyword-page-model.test.ts tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/manual-alexa-voc-rollback.test.ts
npx eslint app/lib/comparison-draft.ts app/lib/comparison-draft-policy.ts app/lib/comparison-project-client.ts app/lib/comparison-project-server.ts app/comparison-project-library-panel.tsx app/api/comparison-projects/config/route.ts app/page.tsx
Assert-NoAffectedTypeDiagnostics @('app/lib/comparison-draft.ts','app/lib/comparison-draft-policy.ts','app/lib/comparison-project-client.ts','app/lib/comparison-project-server.ts','app/comparison-project-library-panel.tsx','app/api/comparison-projects/config/route.ts','tests/web/comparison-draft.test.ts','tests/agent/comparison-project-contract.test.ts','tests/app/comparison-project-api.test.ts','tests/agent/comparison-page-state.test.tsx')
git add -- app/lib/comparison-draft-policy.ts app/api/comparison-projects/config/route.ts app/page.tsx tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx docs/superpowers/reports/2026-08-31-comparison-draft-asin-management-report.md
git commit -m "test(comparison): accept reversible immutable draft management"
```

**Batch 2 gate:** `comparisonDraft` and `committedScope` are the only edit/run boundaries; no three-state ASIN truth remains; Manual overlay/source composition survives; `0021` acceptance commit and rollback flag are complete. Only now may Batch 3 create `0022`.

---

## Batch 3: Plan 03 Evidence Foundation — Strict Contracts, Migration 0022 and Stores

**Dependencies:** Batch 2 acceptance and real latest migration `0021` on both engines.

**Files:**

- Create: `shared/keyword-evidence-contracts.ts`
- Create: `scripts/lib/sif-keyword-capability-registry.mjs`
- Create: `scripts/lib/sif-keyword-strict-adapter.mjs`
- Modify: `scripts/lib/sif-keyword-sync-config.mjs`
- Create: `server/connectors/sif-keyword-capability-source.ts`
- Create: `server/connectors/provider-contracts/sif/manifest.json`
- Create: `tests/fixtures/providers/sif-tools-list.contract-test.json`
- Create: `tests/scripts/sif-keyword-strict-adapter.test.mjs`
- Create: `tests/agent/keyword-evidence-contract.test.ts`
- Create: `server/db/migrations/0022_keyword_evidence.sql`
- Create: `server/db/migrations/postgres/0022_keyword_evidence.sql`
- Modify: `tests/agent/sqlite-migrations.test.ts`
- Modify: `tests/agent/postgres-migrations.test.ts`
- Create: `server/db/keyword-evidence-repository.ts`
- Create: `server/db/postgres/keyword-evidence-store.ts`
- Modify: `server/db/repository.ts`
- Modify: `server/db/postgres-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Create: `tests/agent/postgres-keyword-evidence-repository.test.ts`
- Create: `tests/agent/sqlite-keyword-evidence-repository.test.ts`

**Terminal contract:**

```ts
type KeywordEvidenceMode =
  | "target-canonical"
  | "target-parameter-retry"
  | "parent-listing"
  | "category-proxy";

type KeywordEvidenceStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "schema-error"
  | "quota-blocked";
```

`ready` requires non-empty keywords/null reason; `empty` requires empty keywords/`valid-empty`; `schema-error` requires empty keywords/`schema-invalid`; `quota-blocked` permits only request-budget reasons; unavailable permits only capability/provider/identity/category reasons. Category rows structurally omit listing traffic/rank. Shared category lookup has no target ASIN; each target evidence has a unique evidence id and target-specific CategoryEvidence.

- [ ] **RED strict contracts/registry.** Cover canonical nonempty, strict empty, unknown top field, wrong numeric type, echoed identity mismatch, category shape, unknown descriptor/version, production rejection of `test-only`, empty production registry and exact parameter-compatibility error allowlist.

- [ ] **GREEN contracts and commit B3.1.** `manifest.json` is exactly `{ "schemaVersion": "1.0.0", "fixtures": [] }`. Loader accepts only manifest-listed, checksum-matching, traversal-safe official/saved fixtures. No runtime env/body supplies mappings. Unknown capability returns `unavailable/capability-unknown` and zero HTTP.

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-contract.test.ts
node --test tests/scripts/sif-keyword-strict-adapter.test.mjs
Assert-NoAffectedTypeDiagnostics @('shared/keyword-evidence-contracts.ts','server/connectors/sif-keyword-capability-source.ts','tests/agent/keyword-evidence-contract.test.ts')
git add -- shared/keyword-evidence-contracts.ts scripts/lib/sif-keyword-capability-registry.mjs scripts/lib/sif-keyword-strict-adapter.mjs scripts/lib/sif-keyword-sync-config.mjs server/connectors/sif-keyword-capability-source.ts server/connectors/provider-contracts/sif/manifest.json tests/fixtures/providers/sif-tools-list.contract-test.json tests/scripts/sif-keyword-strict-adapter.test.mjs tests/agent/keyword-evidence-contract.test.ts
git commit -m "feat(keywords): define strict SIF evidence contracts"
```

- [ ] **RED/GREEN `0021 → 0022` and commit B3.2.** Create immutable subject, category lookup, evidence, attempt, receipt, binding and enrichment tables. PostgreSQL verifies project→run→sync-job chain; SQLite references only existing project/run tables and service-verified subject. Category lookup unique key excludes target; target evidence key includes target. Terminal lookup/evidence/binding rows reject update/delete. Receipt permits only reserved→consumed/released.

```powershell
npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
Assert-NoAffectedTypeDiagnostics @('tests/agent/sqlite-migrations.test.ts','tests/agent/postgres-migrations.test.ts')
git add -- server/db/migrations/0022_keyword_evidence.sql server/db/migrations/postgres/0022_keyword_evidence.sql tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
git commit -m "feat(db): add scoped keyword evidence ledger"
```

- [ ] **RED/GREEN repository parity and commit B3.3.** Both stores implement verified subject registration, immutable evidence creation/replay/conflict, append attempts, reserve/sent/settle receipts, category claim/complete/read, per-target materialization, stage binding, exact ordered run read and enrichment revisions. Reads require actor organization + full subject/binding. Corrupt storage raises typed data error, never empty.

```powershell
npx tsx --conditions=react-server --test tests/agent/postgres-keyword-evidence-repository.test.ts tests/agent/sqlite-keyword-evidence-repository.test.ts
Assert-NoAffectedTypeDiagnostics @('server/db/keyword-evidence-repository.ts','server/db/postgres/keyword-evidence-store.ts','server/db/repository.ts','server/db/postgres-repository.ts','server/db/sqlite-repository.ts','tests/agent/postgres-keyword-evidence-repository.test.ts','tests/agent/sqlite-keyword-evidence-repository.test.ts')
git add -- server/db/keyword-evidence-repository.ts server/db/postgres/keyword-evidence-store.ts server/db/repository.ts server/db/postgres-repository.ts server/db/sqlite-repository.ts tests/agent/postgres-keyword-evidence-repository.test.ts tests/agent/sqlite-keyword-evidence-repository.test.ts
git commit -m "feat(keywords): persist immutable scoped evidence"
```

**Batch 3 gate:** Both engines upgrade from the real `0021` head to `0022`; strict status/provenance and target/lookup separation pass; shared category lookup yields distinct per-target evidence; production manifest remains empty and all tests make zero provider HTTP.

---

## Batch 4: Plan 03 Runtime — Receipt Budget, Worker Scope and Bounded Fallback

**Dependencies:** Batch 3 repository contracts.

**Files:**

- Modify: `server/connectors/connector-contract.ts`
- Modify: `server/connectors/remote-mcp-connector.ts`
- Modify: `server/connectors/mcp-connectors.ts`
- Modify: `scripts/lib/sif-mcp-client.mjs`
- Modify: `scripts/lib/postgres-resource-governor.mjs`
- Create: `server/services/keyword-request-budget-service.ts`
- Create/Modify: `tests/agent/keyword-request-budget.test.ts`
- Modify: `tests/agent/remote-mcp-connector.test.ts`
- Create: `tests/scripts/sif-physical-request-budget.test.mjs`
- Modify: `server/db/sync-job-repository.ts`
- Modify: `server/db/postgres/sync-job-store.ts`
- Modify: `server/services/sync-job-worker-handler.ts`
- Create: `server/services/keyword-worker-scope-service.ts`
- Modify: `server/runtime/sync-job-dispatcher.ts`
- Modify: `scripts/run-asin-sync-job.mjs`
- Create: `scripts/lib/keyword-worker-scope.mjs`
- Create: `tests/agent/sync-job-keyword-scope.test.ts`
- Create: `tests/scripts/keyword-worker-scope.test.mjs`
- Create: `scripts/lib/sif-keyword-evidence-runner.mjs`
- Modify: `scripts/build-sif-keyword-analysis.mjs`
- Modify: `scripts/lib/sif-keyword-transform.mjs`
- Create: `tests/scripts/sif-keyword-evidence-runner.test.mjs`
- Create: `scripts/lib/keyword-identity-verifier.mjs`
- Create: `scripts/lib/sif-keyword-fallback-orchestrator.mjs`
- Create: `scripts/lib/sorftime-keyword-cross-validation.mjs`
- Modify: `scripts/lib/sorftime-mcp-client.mjs`
- Create: `tests/scripts/sif-keyword-fallback-orchestrator.test.mjs`
- Create: `tests/scripts/sorftime-keyword-boundary.test.mjs`

**Dispatch scopes:**

```ts
type PhysicalRequestBudgetScope = Readonly<{
  organizationId: string;
  jobId: string;
  provider: "sif" | "sorftime";
  operation: string;
  targetAsin: string;
  categoryId: string | null;
  categoryLookupId: string | null;
  mode: KeywordEvidenceMode;
  paramsHash: string;
  quotaPolicyId: string;
}>;

type KeywordWorkerScope = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  stageId: "keywords";
  jobId: string;
  marketplace: "US";
  orderedTargetAsins: readonly string[];
  dataCutoffAt: string;
  capabilityDescriptorSha256: string;
  providerVersion: string;
  schemaVersion: string;
  quotaPolicyId: string;
}>;
```

- [ ] **RED/GREEN physical accounting and commit B4.1.** Wrap each real `fetchImpl` attempt: local validation/init → reserve → mark sent immediately before fetch → consume in finally if handed off, otherwise release. Keep connector `maxAttempts<=2`; logical fallback starts another connector execution but shares target cap 3. Ledger unavailable/cap exhausted blocks before fetch. Category waiter creates no receipt.

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-request-budget.test.ts tests/agent/remote-mcp-connector.test.ts
node --test tests/scripts/sif-physical-request-budget.test.mjs
Assert-NoAffectedTypeDiagnostics @('server/connectors/connector-contract.ts','server/connectors/remote-mcp-connector.ts','server/connectors/mcp-connectors.ts','server/services/keyword-request-budget-service.ts','tests/agent/keyword-request-budget.test.ts','tests/agent/remote-mcp-connector.test.ts')
git add -- server/connectors/connector-contract.ts server/connectors/remote-mcp-connector.ts server/connectors/mcp-connectors.ts scripts/lib/sif-mcp-client.mjs scripts/lib/postgres-resource-governor.mjs server/services/keyword-request-budget-service.ts tests/agent/keyword-request-budget.test.ts tests/agent/remote-mcp-connector.test.ts tests/scripts/sif-physical-request-budget.test.mjs
git commit -m "feat(keywords): account every physical SIF request"
```

- [ ] **RED/GREEN committed worker scope and commit B4.2.** Dispatcher serializes one base64url JSON scope from DB. Worker strict-parses and re-reads the same job before subject registration/provider action. Omit/alter each field and assert zero subject/evidence/connector calls. Run-bound jobs reject `SIF_ASINS`, global catalog, default organization and generated TS fallback. Legacy generation exists only under `AGENT_KEYWORD_LEGACY_DIAGNOSTIC=1` and cannot run for a committed job.

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-job-keyword-scope.test.ts
node --test tests/scripts/keyword-worker-scope.test.mjs
git add -- server/db/sync-job-repository.ts server/db/postgres/sync-job-store.ts server/services/sync-job-worker-handler.ts server/services/keyword-worker-scope-service.ts server/runtime/sync-job-dispatcher.ts scripts/run-asin-sync-job.mjs scripts/lib/keyword-worker-scope.mjs tests/agent/sync-job-keyword-scope.test.ts tests/scripts/keyword-worker-scope.test.mjs
git commit -m "feat(keywords): enforce committed worker scope"
```

- [ ] **RED/GREEN canonical + one compatible retry and commit B4.3.** Registry selects exact descriptor/provider semantic. Only `INVALID_ARGUMENT` or `UNSUPPORTED_PARAMETER` plus an explicitly audited equivalent mapping permits one alternate request. Valid empty, timeout, auth, quota, 5xx and schema error never trigger parameter retry. Persist attempt/evidence before returning; repository failure fails the stage; runtime writes no generated TS.

```powershell
node --test tests/scripts/sif-keyword-evidence-runner.test.mjs
git add -- scripts/lib/sif-keyword-evidence-runner.mjs scripts/build-sif-keyword-analysis.mjs scripts/lib/sif-mcp-client.mjs scripts/lib/sif-keyword-transform.mjs tests/scripts/sif-keyword-evidence-runner.test.mjs
git commit -m "feat(keywords): run strict target evidence queries"
```

- [ ] **RED/GREEN verified parent/category/Sorftime boundary and commit B4.4.** Continue to parent only from strict target empty or explicit child-listing unsupported. Accept relationship/category only from persisted catalog facts or strict same-target Sorftime detail; reject inference, mismatch, malformed/same ASIN. Category owner completes one target-less lookup; waiters boundedly read it; every target materializes a distinct evidence id. Category rows contain no target traffic/rank. Enrich only deduplicated top 50 final display keywords with separate budget operations; enrichment failure cannot change fallback mode.

```powershell
node --test tests/scripts/sif-keyword-fallback-orchestrator.test.mjs tests/scripts/sorftime-keyword-boundary.test.mjs tests/scripts/sif-physical-request-budget.test.mjs
Assert-NoAffectedTypeDiagnostics @('server/services/keyword-request-budget-service.ts','server/db/keyword-evidence-repository.ts','server/services/keyword-worker-scope-service.ts','tests/agent/sync-job-keyword-scope.test.ts')
git add -- scripts/lib/keyword-identity-verifier.mjs scripts/lib/sif-keyword-fallback-orchestrator.mjs scripts/lib/sorftime-keyword-cross-validation.mjs scripts/lib/sorftime-mcp-client.mjs scripts/build-sif-keyword-analysis.mjs tests/scripts/sif-keyword-fallback-orchestrator.test.mjs tests/scripts/sorftime-keyword-boundary.test.mjs
git commit -m "feat(keywords): add bounded verified evidence fallback"
```

**Batch 4 gate:** Every observed fetch has one consumed receipt; no target exceeds three; waiter receipts are zero; scope mismatch is pre-side-effect; unknown capability/schema/identity fail closed; Sorftime never writes SIF target values.

---

## Batch 5: Plan 03 Stage and Authenticated API Boundary

**Dependencies:** Batch 4 returns committed immutable evidence ids.

**Files:**

- Modify: `shared/agent-contracts.ts`
- Modify: `server/db/sync-job-repository.ts`
- Modify: `server/db/postgres/sync-job-store.ts`
- Modify: `server/services/sync-job-worker-handler.ts`
- Modify: `scripts/lib/sync-stage-output.mjs`
- Modify: `scripts/run-asin-sync-job.mjs`
- Modify/Create: `tests/agent/stage-output-contract.test.ts`
- Modify/Create: `tests/agent/sync-stage-output-persistence.test.ts`
- Modify: `tests/scripts/sync-stage-output.test.mjs`
- Create: `server/services/keyword-evidence-read-service.ts`
- Create: `server/routes/keyword-evidence.ts`
- Modify: `server/app.ts`
- Modify: `app/api/agent/[...path]/route.ts`
- Modify: `app/lib/agent-service-client.ts`
- Create: `tests/agent/keyword-evidence-route.test.ts`
- Modify: `tests/agent/agent-api-schema.test.ts`

**Stage/API contracts:**

```ts
const KeywordStageDataSchema = strictObject({
  evidenceIds: z.array(EntityIdSchema).min(1).max(10),
});

type KeywordEvidenceApiResponse = Readonly<{
  runId: string;
  stageId: "keywords";
  evidences: readonly KeywordEvidenceApiItem[];
}>;
```

- [ ] **RED/GREEN id-only stage output and commit B5.1.** Reject raw maps, duplicate/uncommitted/cross-job ids, lookup ids and incorrect scope/target coverage. Worker completion transaction validates one terminal target evidence per ordered target, inserts immutable bindings and then persists output/hash/version atomically. Replay same ids/hash is idempotent. `projectStageOutput("keywords")` reads only worker id manifest; keyword entries leave `projectionSources`. Add strict gap `FEATURE_DISABLED` for Batch 7.

```powershell
npx tsx --conditions=react-server --test tests/agent/stage-output-contract.test.ts tests/agent/sync-stage-output-persistence.test.ts
npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/comparison-project-contract.test.ts
node --test tests/scripts/sync-stage-output.test.mjs
Assert-NoAffectedTypeDiagnostics @('shared/agent-contracts.ts','server/db/sync-job-repository.ts','server/db/postgres/sync-job-store.ts','server/services/sync-job-worker-handler.ts','tests/agent/stage-output-contract.test.ts','tests/agent/sync-stage-output-persistence.test.ts','tests/agent/contracts.test.ts','tests/agent/comparison-project-contract.test.ts')
git add -- shared/agent-contracts.ts server/db/sync-job-repository.ts server/db/postgres/sync-job-store.ts server/services/sync-job-worker-handler.ts scripts/lib/sync-stage-output.mjs scripts/run-asin-sync-job.mjs tests/agent/stage-output-contract.test.ts tests/agent/sync-stage-output-persistence.test.ts tests/scripts/sync-stage-output.test.mjs
git commit -m "feat(keywords): bind stage output to evidence ids"
```

- [ ] **RED/GREEN exact-set run API and commit B5.2.** `GET /v1/runs/:runId/keyword-evidence?ids=...` accepts 1–10 ordered unique ids. Service derives organization from principal, loads run→project→keywords output, verifies exact binding set and all full scope identities. Any mixed/foreign/wrong/unbound id returns indistinguishable all-or-nothing 404; storage/schema failures return typed 503; static fallback never runs. Response preserves mode/status/reason/target/lookup/category/provenance/enrichment/cross-validation and only redacted quota counts.

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-route.test.ts tests/agent/agent-api-schema.test.ts
Assert-NoAffectedTypeDiagnostics @('shared/agent-contracts.ts','server/services/keyword-evidence-read-service.ts','server/routes/keyword-evidence.ts','server/app.ts','app/api/agent/[...path]/route.ts','app/lib/agent-service-client.ts','tests/agent/keyword-evidence-route.test.ts','tests/agent/agent-api-schema.test.ts')
git add -- shared/agent-contracts.ts server/services/keyword-evidence-read-service.ts server/routes/keyword-evidence.ts server/app.ts app/api/agent/[...path]/route.ts app/lib/agent-service-client.ts tests/agent/keyword-evidence-route.test.ts tests/agent/agent-api-schema.test.ts
git commit -m "feat(api): expose run-scoped keyword evidence"
```

**Batch 5 gate:** Stage output contains only exact target-scoped evidence ids; category lookup id never masquerades as evidence; authenticated API is run-scoped, exact-set and tenant-safe; Plan 02 comparison regression remains green.

---

## Batch 6: Plan 03 UI, Static-Consumer Cutover, Export and Product Definition

**Dependencies:** Batch 5 authenticated read service and id-only stage output.

**Files — browser/view and complete client cutover:**

- Create: `app/lib/keyword-evidence-browser.ts`
- Create: `app/keyword-evidence-view.ts`
- Modify: `app/lib/stage-output-browser.ts`
- Modify: `app/lib/stage-output-view.ts`
- Modify: `app/keyword-demand-analysis.ts`
- Modify: `app/keyword-demand-conclusions.ts`
- Modify: `app/keyword-fetch-status.tsx`
- Modify: `app/keyword-demand-section.tsx`
- Modify: `app/product-launch-analysis.ts`
- Modify: `app/product-launch-recommendation.tsx`
- Modify: `app/voc-positioning-section.tsx`
- Modify: `app/product-definition-section.tsx`
- Modify: `app/launch-checklist-section.tsx`
- Modify: `app/page.tsx`
- Create: `tests/agent/keyword-evidence-browser.test.ts`
- Create: `tests/agent/keyword-evidence-ui.test.tsx`
- Modify: `tests/agent/stage-output-browser.test.ts`
- Modify: `tests/agent/voc-keyword-page-model.test.ts`

**Files — shared downstream projection:**

- Create: `server/services/keyword-evidence-projection-service.ts`
- Modify: `app/launch-checklist-export.ts`
- Modify: `app/final-product-definition.ts`
- Modify: `server/data/keyword-analysis-snapshot.ts`
- Modify: `server/services/product-definition-execution-service.ts`
- Modify: `server/services/product-definition-worker-handler.ts`
- Modify: `server/domain/product/product-definition-contracts.ts`
- Create: `tests/agent/keyword-evidence-export.test.ts`
- Modify: `tests/agent/product-definition-runtime.test.ts`

- [ ] **RED epoch-safe hydration and presentation.** Evidence fetch begins only after matching stage output. Session/org/project/run/job epoch change clears owner and rejects stale responses. Render fixed source labels. Parent traffic belongs to lookup ASIN and is separated; category only enters demand discovery; cross-validation never changes SIF values; two targets sharing category lookup retain two target cards/evidence ids.

- [ ] **RED every static consumer and Manual merge.** `tests/agent/voc-keyword-page-model.test.ts` supplies Manual VOC only through current overlay and keyword evidence only through accepted run view. All launch/positioning/definition/checklist consumers must see both. Missing keyword evidence yields typed missing/C-grade; missing Manual VOC stays bounded. Old-organization late responses reach none of them.

- [ ] **GREEN complete client cutover and commit B6.1.** `createKeywordEvidenceOwner` accepts only matching stage ids and exact API response. `buildKeywordDemandAnalysis` requires evidence-derived input and returns typed missing if absent. `keyword-demand-conclusions` takes explicit enrichment/provenance. `stage-output-view` no longer merges keyword static maps. Keep Batch 0 `ProductLaunchRuntimeSources` unchanged: page sets `manualVocByAsin` from the current Manual owner and `keywordDemand` from the current evidence view, then passes one object to all four components. No optional/default source parameter is allowed.

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-browser.test.ts tests/agent/keyword-evidence-ui.test.tsx tests/agent/stage-output-browser.test.ts tests/agent/voc-keyword-page-model.test.ts
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/manual-alexa-voc-rollback.test.ts tests/agent/comparison-page-state.test.tsx
rg -n 'sif-keyword-(analysis|enrichment)-data' app/page.tsx app/keyword-fetch-status.tsx app/keyword-demand-analysis.ts app/keyword-demand-conclusions.ts app/lib/stage-output-view.ts app/product-launch-analysis.ts app/product-launch-recommendation.tsx app/voc-positioning-section.tsx app/product-definition-section.tsx app/launch-checklist-section.tsx
```

  Expected: both test commands pass and `rg` returns exit 1/no matches. Server-only diagnostic modules outside this client-reachable list may retain explicit imports.

```powershell
Assert-NoAffectedTypeDiagnostics @('app/lib/keyword-evidence-browser.ts','app/keyword-evidence-view.ts','app/lib/stage-output-browser.ts','app/lib/stage-output-view.ts','app/keyword-demand-analysis.ts','app/keyword-demand-conclusions.ts','app/keyword-fetch-status.tsx','app/keyword-demand-section.tsx','app/product-launch-analysis.ts','app/product-launch-recommendation.tsx','app/voc-positioning-section.tsx','app/product-definition-section.tsx','app/launch-checklist-section.tsx','tests/agent/keyword-evidence-browser.test.ts','tests/agent/keyword-evidence-ui.test.tsx','tests/agent/stage-output-browser.test.ts','tests/agent/voc-keyword-page-model.test.ts')
git add -- app/lib/keyword-evidence-browser.ts app/keyword-evidence-view.ts app/lib/stage-output-browser.ts app/lib/stage-output-view.ts app/keyword-demand-analysis.ts app/keyword-demand-conclusions.ts app/keyword-fetch-status.tsx app/keyword-demand-section.tsx app/product-launch-analysis.ts app/product-launch-recommendation.tsx app/voc-positioning-section.tsx app/product-definition-section.tsx app/launch-checklist-section.tsx app/page.tsx tests/agent/keyword-evidence-browser.test.ts tests/agent/keyword-evidence-ui.test.tsx tests/agent/stage-output-browser.test.ts tests/agent/voc-keyword-page-model.test.ts
git commit -m "feat(ui): hydrate scoped keyword evidence across product analysis"
```

- [ ] **RED/GREEN export/product-definition provenance and commit B6.2.** One projection service accepts `{actorOrganizationId,runId,evidenceIds}` and reuses the same binding/auth checks as GET. UI export uses authenticated GET; worker uses projection service with principal scope. Snapshot hash includes evidence id, target/lookup/category lookup/hash, mode/status/reason, operation/query variant, params/schema/provider version, window/time, relationship/category evidence, enrichment revisions and cross-validation. Model output retains sourceMode/scopeLabel; category cannot support target traffic claim; parent names lookup ASIN. Export excludes raw receipt ids/URLs/headers/tokens/bodies.

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-export.test.ts tests/agent/product-definition-runtime.test.ts tests/agent/postgres-keyword-analysis-snapshot-repository.test.ts
Assert-NoAffectedTypeDiagnostics @('server/services/keyword-evidence-projection-service.ts','app/launch-checklist-export.ts','app/final-product-definition.ts','app/product-definition-section.tsx','server/data/keyword-analysis-snapshot.ts','server/services/product-definition-execution-service.ts','server/services/product-definition-worker-handler.ts','server/domain/product/product-definition-contracts.ts','tests/agent/keyword-evidence-export.test.ts')
git add -- server/services/keyword-evidence-projection-service.ts app/launch-checklist-export.ts app/final-product-definition.ts app/product-definition-section.tsx server/data/keyword-analysis-snapshot.ts server/services/product-definition-execution-service.ts server/services/product-definition-worker-handler.ts server/domain/product/product-definition-contracts.ts tests/agent/keyword-evidence-export.test.ts tests/agent/product-definition-runtime.test.ts
git commit -m "feat(product): preserve keyword evidence provenance"
```

**Batch 6 gate:** Static keyword imports/defaults/merges are absent from all client-reachable consumers; Manual overlay and keyword evidence share one epoch-safe product source; UI/export/product definition use the same run-scoped projection and preserve mode limitations.

---

## Batch 7: Plan 03 Release Convergence and Truthful Baseline Classification

**Dependencies:** Batch 6 complete client/downstream cutover.

**Files:**

- Create: `server/config/keyword-evidence-policy.ts`
- Create: `server/services/keyword-evidence-observability.ts`
- Modify: `server/config.ts`
- Modify: `server/services/sync-publication-status-service.ts`
- Modify: `server/services/sync-job-worker-handler.ts`
- Modify: `scripts/build-sif-keyword-analysis.mjs`
- Modify: `scripts/run-stable-build.mjs`
- Modify: `tests/scripts/run-stable-build.test.mjs`
- Create: `tests/agent/keyword-evidence-policy.test.ts`
- Create: `tests/agent/keyword-evidence-observability.test.ts`
- Create: `tests/agent/keyword-client-bundle.test.ts`
- Create: `tests/agent/keyword-evidence-fallback-acceptance.test.ts`
- Create: `docs/superpowers/reports/2026-08-31-sif-keyword-evidence-fallback-report.md`

**Policy:**

```ts
type KeywordEvidencePolicy = Readonly<{
  repositoryShadow: boolean;
  strictCanonical: boolean;
  parameterRetry: boolean;
  parentListing: boolean;
  categoryProxy: boolean;
  sorftimeCrossValidation: boolean;
}>;
```

All six booleans default false and are independently parseable. Recommended enable order is shadow → strict canonical → parameter retry → parent → category → Sorftime; runtime does not silently enable dependencies. Disabling affects only new runs and never relabels/deletes evidence.

- [ ] **RED policy/metrics/acceptance/build safety.** Test default-off/out-of-order flags, exact redacted metrics, all terminal paths, three-receipt cutoff, category concurrency, tenant 404 and UI/export/product-definition provenance. Production empty manifest must yield capability-unknown and zero HTTP. Extend `tests/scripts/run-stable-build.test.mjs` to prove keyword scan uses the existing lock/fingerprint/failure-cleanup/atomic-acceptance transaction. Existing Manual bundle sentinels remain unchanged.

- [ ] **GREEN flags and terminal behavior.** If all evidence-producing levels are disabled after repository cutover, new keyword stage persists `partial/FEATURE_DISABLED`, no evidence ids, no provider request and no generated TS read. A single disabled level does not disable another enabled eligible level. Emit one terminal event per target with keyed organization hash and no sensitive provider/query/keyword material.

- [ ] **GREEN combined stable-build gate.** After successful compilation and before candidate artifact acceptance, run Manual VOC scan then Keyword scan against the same candidate. Either failure follows existing cleanup and preserves previous accepted artifact. Keyword scan rejects module names, tenant org/ASIN, evidence payload and owner-manifest sentinels in client manifests/chunks/source maps. Server-only migration/diagnostic imports are allowlisted explicitly.

- [ ] **Run focused and affected release gates.**

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-policy.test.ts tests/agent/keyword-evidence-observability.test.ts tests/agent/keyword-client-bundle.test.ts tests/agent/keyword-evidence-fallback-acceptance.test.ts
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-contract.test.ts tests/agent/postgres-keyword-evidence-repository.test.ts tests/agent/sqlite-keyword-evidence-repository.test.ts tests/agent/keyword-request-budget.test.ts tests/agent/sync-job-keyword-scope.test.ts tests/agent/stage-output-contract.test.ts tests/agent/sync-stage-output-persistence.test.ts tests/agent/keyword-evidence-route.test.ts tests/agent/keyword-evidence-browser.test.ts tests/agent/keyword-evidence-ui.test.tsx tests/agent/keyword-evidence-export.test.ts tests/agent/product-definition-runtime.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts tests/agent/manual-alexa-voc-rollback.test.ts tests/agent/comparison-page-state.test.tsx tests/agent/voc-keyword-page-model.test.ts
node --test tests/scripts/sif-keyword-strict-adapter.test.mjs tests/scripts/sif-physical-request-budget.test.mjs tests/scripts/keyword-worker-scope.test.mjs tests/scripts/sif-keyword-evidence-runner.test.mjs tests/scripts/sif-keyword-fallback-orchestrator.test.mjs tests/scripts/sorftime-keyword-boundary.test.mjs tests/scripts/sync-stage-output.test.mjs tests/scripts/run-stable-build.test.mjs
npx eslint shared/keyword-evidence-contracts.ts server/db/keyword-evidence-repository.ts server/db/postgres/keyword-evidence-store.ts server/services/keyword-request-budget-service.ts server/services/keyword-evidence-read-service.ts server/services/keyword-evidence-projection-service.ts server/services/keyword-evidence-observability.ts server/config/keyword-evidence-policy.ts server/routes/keyword-evidence.ts app/lib/keyword-evidence-browser.ts app/keyword-evidence-view.ts app/lib/stage-output-view.ts app/keyword-demand-analysis.ts app/keyword-demand-conclusions.ts app/keyword-fetch-status.tsx app/keyword-demand-section.tsx app/product-launch-analysis.ts app/product-launch-recommendation.tsx app/voc-positioning-section.tsx app/product-definition-section.tsx app/launch-checklist-section.tsx
Assert-NoAffectedTypeDiagnostics @('shared/keyword-evidence-contracts.ts','server/db/keyword-evidence-repository.ts','server/db/postgres/keyword-evidence-store.ts','server/services/keyword-request-budget-service.ts','server/services/keyword-evidence-read-service.ts','server/services/keyword-evidence-projection-service.ts','server/services/keyword-evidence-observability.ts','server/config/keyword-evidence-policy.ts','server/routes/keyword-evidence.ts','app/lib/keyword-evidence-browser.ts','app/keyword-evidence-view.ts','app/lib/stage-output-view.ts','app/keyword-demand-analysis.ts','app/keyword-demand-conclusions.ts','app/keyword-fetch-status.tsx','app/keyword-demand-section.tsx','app/product-launch-analysis.ts','app/product-launch-recommendation.tsx','app/voc-positioning-section.tsx','app/product-definition-section.tsx','app/launch-checklist-section.tsx')
```

- [ ] **Run build and both bundle gates.**

```powershell
npm run build
node --test tests/manual-alexa-voc-client-bundle.test.mjs
npx tsx --conditions=react-server --test tests/agent/keyword-client-bundle.test.ts
```

  Require production build exit 0, Manual bundle gate 2/2, keyword bundle gate pass, and stable-build lock/fingerprint/cleanup regression pass. Do not start Web or Agent services.

- [ ] **Run and classify full TypeScript instead of claiming it is green.** Normalize baseline/current by path + TS code + message, excluding line/column so moved unchanged diagnostics remain comparable:

```powershell
function Normalize-TscDiagnostic([string]$Line) {
  $normalized = $Line.Replace('\\', '/')
  if ($normalized -match '^([^\(]+)\(\d+,\d+\): error (TS\d+): (.*)$') {
    return "$($Matches[1])|$($Matches[2])|$($Matches[3])"
  }
  return $null
}

$baselineRaw = Get-Content -LiteralPath '.superpowers/sdd/voc-keyword-tsc-baseline.txt'
$currentRaw = @(& npx tsc --noEmit --incremental false --pretty false 2>&1)
$currentExit = $LASTEXITCODE
$baseline = @($baselineRaw | ForEach-Object { Normalize-TscDiagnostic "$_" } | Where-Object { $_ } | Sort-Object -Unique)
$current = @($currentRaw | ForEach-Object { Normalize-TscDiagnostic "$_" } | Where-Object { $_ } | Sort-Object -Unique)
$introduced = @(Compare-Object $baseline $current | Where-Object SideIndicator -eq '=>' | ForEach-Object InputObject)
$resolved = @(Compare-Object $baseline $current | Where-Object SideIndicator -eq '<=' | ForEach-Object InputObject)
$retained = @($current | Where-Object { $baseline -contains $_ })
"FULL_TSC_EXIT=$currentExit"
"BASELINE=306"
"RETAINED=$($retained.Count)"
"RESOLVED=$($resolved.Count)"
"INTRODUCED=$($introduced.Count)"
if ($introduced.Count -ne 0 -or $current.Count -gt 306) { $introduced; throw 'TypeScript baseline regressed' }
```

  Record actual `FULL_TSC_EXIT`. If it remains 2, state that full typecheck remains red with retained baseline diagnostics. Do not write “typecheck passed.” Also run `npm run lint`, record its actual exit/count against the Batch 0 lint snapshot, and do not call full lint green unless it exits 0.

- [ ] **Verify rollback matrix.** All flags off → new stage `partial/FEATURE_DISABLED`, zero HTTP/evidence ids/static reads. Enable in recommended order and verify each mode. Disable each independently and out of order; only new runs change. Historical evidence/receipts/bindings stay readable via authenticated run API.

- [ ] **Write the release report and commit B7.1.** Report exact commands, pass counts, commit SHAs, migration heads, build fingerprint, both bundle results, full compiler/lint exits, retained/resolved/introduced diagnostic counts, zero-live-provider/port statement, empty production capability manifest and rollout blocker.

```powershell
git diff --check -- server/config/keyword-evidence-policy.ts server/services/keyword-evidence-observability.ts server/config.ts server/services/sync-publication-status-service.ts server/services/sync-job-worker-handler.ts scripts/build-sif-keyword-analysis.mjs scripts/run-stable-build.mjs tests/scripts/run-stable-build.test.mjs tests/agent/keyword-evidence-policy.test.ts tests/agent/keyword-evidence-observability.test.ts tests/agent/keyword-client-bundle.test.ts tests/agent/keyword-evidence-fallback-acceptance.test.ts docs/superpowers/reports/2026-08-31-sif-keyword-evidence-fallback-report.md
git add -- server/config/keyword-evidence-policy.ts server/services/keyword-evidence-observability.ts server/config.ts server/services/sync-publication-status-service.ts server/services/sync-job-worker-handler.ts scripts/build-sif-keyword-analysis.mjs scripts/run-stable-build.mjs tests/scripts/run-stable-build.test.mjs tests/agent/keyword-evidence-policy.test.ts tests/agent/keyword-evidence-observability.test.ts tests/agent/keyword-client-bundle.test.ts tests/agent/keyword-evidence-fallback-acceptance.test.ts docs/superpowers/reports/2026-08-31-sif-keyword-evidence-fallback-report.md
git diff --cached --name-only
git commit -m "test(keywords): gate scoped evidence rollout"
```

**Batch 7 gate:** Focused/affected tests, migrations, build, Manual bundle, Keyword bundle and diff-check are green; full compiler/lint are reported exactly and introduce no new diagnostics; rollback is independent and non-destructive. Production strict SIF enablement remains blocked until the separate audited capability fixture/manifest commit exists.

---

## Cross-Batch Safety Gates

| Contract | B0 | B1 | B2 | B3 | B4 | B5 | B6 | B7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Manual overlay/session epoch | repair + prove | regression | preserve through page rewrite | unchanged | unchanged | unchanged | merge with keyword owner | bundle/regression |
| Immutable comparison scope | prerequisite only | migration/routes | sole page boundary | subject source | worker verification | binding/API | owner keys | rollback |
| Tenant 404 | existing | project/legacy | client echo | repository | worker subject | exact-set GET | projection | acceptance |
| Request receipts <=3 | — | — | — | schema/storage | enforced | summarized | redacted projection | acceptance/metrics |
| Static keyword client graph | explicit page input | preserved | preserved | migration-only declaration | runtime stops writes | stage stops reads | zero matches | emitted bundle gate |
| Migration head | 0020 | 0021 | 0021 accepted | 0022 | 0022 | 0022 | 0022 | 0022 |

## Commit and WIP Discipline

- Every commit unit above is a review boundary; batches are integration checkpoints and are not permission to squash unrelated units.
- Before each commit, run `git diff --cached --name-only` and compare it literally with that unit's `git add -- ...` list. If a generated app data file, publication state, project JSON or pre-existing `.superpowers/sdd/task-3-report.md` appears, unstage only that exact path with `git restore --staged -- <path>`; do not alter its working-tree contents.
- After each batch, run `git status --short --branch` and confirm all pre-existing WIP remains present and unstaged. Record only plan-owned commit SHAs in the batch report.
- Provider-contract approval, if obtained, is its own reviewed commit after B3.1 and before enabling `strictCanonical`; it must contain only sanitized fixture/manifest/checksum documentation and no tenant response body.

## Self-Review Result

- Spec coverage is complete for the requested recovery order: current blockers → Plan 02 `0021` immutable comparison scope → Plan 03 `0022` strict adapter/evidence/request budget/fallback/stage/API/UI/export/release.
- All direct static keyword consumers identified at the planning baseline are owned by Batch 6, including the previously omitted `app/keyword-demand-conclusions.ts` and `app/lib/stage-output-view.ts`; indirect product-analysis consumers are explicit and Manual VOC remains merged.
- Type names are consistent end-to-end: `ProductLaunchRuntimeSources` remains the Batch 0–6 page/model interface; `KeywordCategoryLookup` is target-less; `KeywordEvidence` is target-scoped; stage/API use evidence ids, never lookup ids.
- Every batch has exact files, focused RED/GREEN commands, commit paths/messages, dependencies and affected safety gates. Full compiler success is not asserted; the known 306 diagnostics are classified only in Batch 7.
- Placeholder scan and whitespace gate for this plan:

```powershell
rg -n "[T]BD|[T]ODO|[F]IXME|[l]ater|[s]imilar to|待[定]|后续[补]|占[位]" docs/superpowers/plans/2026-08-31-voc-keyword-runtime-recovery.md
git diff --check -- docs/superpowers/plans/2026-08-31-voc-keyword-runtime-recovery.md
```

  Expected: placeholder scan returns exit 1/no matches; diff-check returns exit 0.

## Authorized Execution Handoff

The user has already authorized automatic planning and execution. Do not ask for an execution-mode choice. Start with Batch 0 using `superpowers:executing-plans`, stop at every batch gate if a safety contract fails, and continue only from the last accepted commit.
