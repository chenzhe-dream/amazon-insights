# Stale resume fixture repair

## RED source

At HEAD `16d9bb3`, the production-main resume gate had two stale fake price-strategy records containing only `{ anchor: 1 }`:

- the three-ASIN Sorftime fake runner left successful price strategy output classified as `upstream-empty`;
- the image-remarks project setup left both ASINs MCP-missing, so preceding stages ran before image remarks.

The production readiness predicate requires `status: "ready"` and a positive `currentPrice`.

## GREEN

Both stale fixture records now emit `{ status: "ready", currentPrice: 1, anchor: 1 }`.

Verified from regular Windows PowerShell:

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-category-resume.test.ts tests/agent/sync-job-production-main-resume.test.ts
```

Result: 18/18 tests passed.

Focused lint also passed:

```powershell
npx eslint tests/agent/sync-category-resume.test.ts tests/agent/sync-job-production-main-resume.test.ts
```

`git diff --check` passed. This report is committed with the atomic fixture repair.
