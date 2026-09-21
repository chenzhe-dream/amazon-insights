# Verification — 2026-09-16

## Reproduction and change
Browser fixture on `http://market-http.test` confirms `isSecureContext=false`, `crypto.randomUUID=undefined`, and `crypto.getRandomValues` available. Before the fix, overview filtering, overview analysis, and themes throw `crypto.randomUUID is not a function`; shape/keyword submission cannot reach the captured API. The exact user input is US node `1069828`, month `2026-08`.

Added browser UUID v4 helper; replaced direct UUID calls in eight market components only. Initial overview command preparation is now inside its mutation error boundary. No provider, server, schema, business data, or analysis-rule changes. Compared release inputs against the previous release snapshot; only these eight components and the helper changed.

## Checks
- New insecure-origin regression: 6/6 including parent test; five entry points submit the exact node, show captured 503 errors, and reuse keys on retry. Both 搜索 and 筛选市场 exercised.
- Six existing affected suites: 22 distinct tests eventually passed. Initial concurrent run passed 20 and timed out loading two browser fixtures; those suites were rerun sequentially, 3/3 passed. Failure logs retained.
- Shared favorite regression runs both with and without randomUUID; persistence, restore, and duplicate-save key reuse pass.
- Typecheck passed. OpenSpec strict validation passed.
- Scoped ESLint retains the exact 11 pre-existing React hook errors from the previous release snapshot; no new application errors. Existing unused Page import warning in favorite test unchanged. Not claiming the repository is lint-clean.
- Formal manager production build passed. No live provider queries were performed in this repair's tests.

## Release
- Published at 2026-09-16 16:29:56 Asia/Shanghai using `manage-formal-stack.ps1 -PublishCode`; active-job preflight was zero.
- Source hash: `8dbf6287e3f7756dc0750b27bd6b4130529edfe691c923da1e6c71bb248fbb3b`.
- Web artifact: `919a194efba05f7a81f2f3b6af9a85ee0d61bbfe9c63420df4a2061cd820e6b9`.
- Request: `5cf76b663b6a143655bee982dd9845648d345056541b6a64ba85af0e39d4c1af`.
- Postflight at 16:30:17: localhost and LAN web health and agent health HTTP 200; all report the new code source. Current-known-good source equals checked workspace. Business stage hashes unchanged.
- Previous pointer/state backup: `C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/market-http-20260916`; previous immutable artifact retained.

Evidence logs: `.superpowers/sdd/market-http-{red,green,regression,regression-retry,typecheck,lint,release}.log`, `market-http-lint-comparison.json`, and `market-http-release-verification.json`.

## Operator acceptance
Reload the formal page with Ctrl+F5, select US and 2026-08, enter node 1069828, then click 筛选市场. Submission should reach the backend and expose loading, job status, or an explicit request error. Successful paid upstream analysis remains for operator acceptance; browser command tests and health checks do not establish provider availability.
