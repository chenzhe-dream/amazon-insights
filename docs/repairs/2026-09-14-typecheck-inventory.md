# 全仓类型检查分布（2026-09-14）

**修复状态：本轮 `npm run typecheck` 已通过（退出码 0、零诊断）。** 以下保留修复前的 439 条错误分布，方便追溯，不代表当前仍有这些错误。修复及验证记录见 [类型错误修复验收](2026-09-14-typecheck-repair-acceptance.md)。

本次重新执行：npm exec -- tsc --noEmit --pretty false --incremental false。共 439 条诊断，94 个文件；其中业务/运行代码 163 条，测试及测试夹具 276 条。重复诊断不等于独立功能故障数。

上轮漏报了一处本次新增接线错误：server/app.ts 将 usageAnalytics 传给 registerAuthRoutes，未传给 registerAdminUserPresenceRoutes，导致正式构造入口的 usage 心跳返回 503。已通过正式 buildAgentApp 加真实隔离 PostgreSQL 的失败/成功回归复现并修复；相关 16 项测试通过。修复后该类型错误消失，其余数量由 440 降为 439。

## 业务与运行代码

| 文件 | 数量 | 首个错误摘要 |
|---|---:|---|
| app/sorftime-listing-content-data.ts:530 | 39 | TS2353 Object literal may only specify known properties, and '"stageId"' does not exist in type '{ jobId: string; marketplace: string; asin: string; operation: string; fetchedAt: string; … |
| app/competitor-data.ts:2577 | 38 | TS1117 An object literal cannot have multiple properties with the same name. |
| server/services/sif-traffic-snapshot-task.ts:596 | 17 | TS2339 Property 'score' does not exist on type 'object'. |
| app/sorftime-fba-fee-data.ts:32 | 13 | TS2353 Object literal may only specify known properties, and '"sorftimeFbaFee"' does not exist in type 'SorftimeFbaFeeRecord'. |
| app/page.tsx:1740 | 8 | TS2345 Argument of type '(path: string, init?: RequestInit) => Promise<Response>' is not assignable to parameter of type '{ (input: URL / RequestInfo, init?: RequestInit / undefined): Pro… |
| server/runtime/openai-provider.ts:218 | 5 | TS18046 'inputTokens' is of type 'unknown'. |
| server/security/alexa-voc-normalization-input-cipher.ts:170 | 4 | TS7031 Binding element 'identity' implicitly has an 'any' type. |
| server/connectors/mcp-connectors.ts:110 | 4 | TS2352 Conversion of type '{ SIF_MCP_SECRET: string; }' to type 'ProcessEnv' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert t… |
| app/lib/sync-terminal-owner.ts:63 | 4 | TS2367 This comparison appears to be unintentional because the types '3 / undefined' and '1' have no overlap. |
| app/sif-keyword-field-glossary.ts:70 | 3 | TS2339 Property 'sifName' does not exist on type '{ readonly label: "关键词"; readonly meaning: "SIF 反查进入搜索结果前三页、且落在 ABA 月搜索排名前约 100 万（以美国站为例）的流量词。"; } / { readonly label: "含义分类"; readonly m… |
| server/domain/voc/voc-positioning-contracts.ts:484 | 3 | TS2339 Property 'theme' does not exist on type '{ dimension: "attention" / "positives" / "negatives" / "unmet" / "audiences" / "scenarios" / "motives"; theme: { key: string; label: string… |
| server/routes/local-voc.ts:103 | 3 | TS18047 'source.candidate' is possibly 'null'. |
| server/cli/seed-test-users.ts:118 | 2 | TS2345 Argument of type '{ id: `${string}-${string}-${string}-${string}-${string}`; organizationId: string; email: string; displayName: string; role: "member" / "admin"; status: string; c… |
| server/routes/local-data.ts:149 | 2 | TS2322 Type '{ authorizeSyncScope(principal: RequestPrincipal, input: { projectId?: string / undefined; runId?: string / undefined; }): Promise<{ organizationId: string; projectId: null; … |
| worker/index.ts:6 | 2 | TS2304 Cannot find name 'Fetcher'. |
| app/launch-checklist-export.ts:161 | 2 | TS2339 Property 'autoValue' does not exist on type 'LaunchChecklistEntry / { id: string; label: string; source: "manual"; }'. |
| app/final-product-definition.ts:272 | 2 | TS2367 This comparison appears to be unintentional because the types '"P1" / "P2" / "P3" / "待验证"' and '"P0"' have no overlap. |
| app/lib/competitor-metric-resolution.ts:39 | 2 | TS2322 Type 'number / null / undefined' is not assignable to type 'number / null'. |
| server/evaluation/analysis-agent-auto-evaluator.ts:163 | 2 | TS2339 Property 'missingDependencies' does not exist on type '{ schemaVersion: "1.0.0"; kind: "voc-positioning-input"; snapshot: { id: string; contentHash: string; marketplace: string; as… |
| server/evaluation/analysis-agent-eval-set.ts:426 | 1 | TS2322 Type '{ dimension: "attention" / "positives" / "negatives" / "unmet" / "audiences" / "scenarios" / "motives"; themeKey: string; priority: "P0"; safetyRule: "safety" / "compliance" … |
| app/voc-evidence-definition.tsx:228 | 1 | TS2367 This comparison appears to be unintentional because the types '"queued" / "succeeded" / "waiting-voc" / "waiting-keywords" / "definition-running" / undefined' and '"voc-running"' h… |
| db/index.ts:1 | 1 | TS2307 Cannot find module 'cloudflare:workers' or its corresponding type declarations. |
| app/sorftime-category-trend-data.ts:38 | 1 | TS2353 Object literal may only specify known properties, and '"asin"' does not exist in type 'SorftimeCategoryTrendRecord'. |
| app/lib/trigger-rebuild.ts:32 | 1 | TS2322 Type 'string' is not assignable to type '`${string}-${string}-${string}-${string}-${string}`'. |
| app/concurrency-admin-panel.tsx:341 | 1 | TS2322 Type '{ configured: boolean; available: boolean; reason: string / null; checkedAt: string / null; connectorId: "sellerSprite" / "sorftime" / "sif"; } / { configured: boolean; avail… |
| server/cli/hidden-password-prompt.ts:46 | 1 | TS2769 No overload matches this call. |
| app/asin-sync-funnel.tsx:457 | 1 | TS2345 Argument of type '{ jobId: string; asins: string[]; marketplace: string; status: string; message: string; currentStageId: string; stages: { id: string; label: string; kind: "manual… |

## 测试与夹具

主要包括 SQLite 仓库接口不匹配（缺少 syncJobs）、过期测试入参、环境变量类型缺失、模拟返回值不符合当前协议。

| 文件 | 数量 |
|---|---:|
| tests/agent/sif-traffic-snapshot-task.test.ts | 51 |
| tests/agent/sync-category-resume.test.ts | 13 |
| tests/agent/sync-job-production-main-resume.test.ts | 13 |
| tests/agent/connector-resource-governor.test.ts | 12 |
| tests/agent/postgres-analysis-report-repository.test.ts | 11 |
| tests/agent/analysis-report-repository.test.ts | 10 |
| tests/agent/analysis-run-lifecycle.test.ts | 10 |
| tests/agent/trigger-rebuild.test.ts | 10 |
| tests/agent/sync-job-detached-provider.test.ts | 9 |
| tests/agent/connector-secret-config.test.ts | 8 |
| tests/agent/local-data-bridge.test.ts | 7 |
| tests/agent/voc-positioning-runtime.test.ts | 7 |
| tests/agent/helpers/asin-sync-funnel-browser-harness.tsx | 7 |
| tests/agent/sync-dynamic-traffic-start.test.ts | 5 |
| tests/agent/sync-persisted-readiness-reconciliation.test.ts | 5 |
| tests/agent/feedback.test.ts | 5 |
| tests/agent/asin-sync-session.test.ts | 5 |
| tests/agent/web-auth-session.test.ts | 5 |
| tests/agent/postgres-core-repository.test.ts | 4 |
| tests/agent/connector-probe-service.test.ts | 4 |
| tests/agent/postgres-concurrency-control.test.ts | 3 |
| tests/agent/formal-voc-submission.test.ts | 3 |
| tests/agent/sync-job-worker-handler-lifecycle.test.ts | 3 |
| tests/agent/sync-provider-readiness-gate.test.ts | 3 |
| tests/agent/helpers/stage-results-category-retry-fixture.ts | 3 |
| tests/agent/legacy-sync-route.test.ts | 3 |
| tests/agent/product-definition-runtime.test.ts | 2 |
| tests/agent/sellersprite-mcp-handshake.test.ts | 2 |
| tests/agent/traffic-voc-isolation.test.ts | 2 |
| tests/agent/sync-stage-output-persistence.test.ts | 2 |
| tests/agent/sync-provider-degraded-admin.test.ts | 2 |
| tests/agent/sync-legacy-status-repair.test.ts | 2 |
| tests/agent/voc-automation-repository.test.ts | 2 |
| tests/agent/admin-init-cli.test.ts | 2 |
| tests/agent/postgres-agent-run-repository.test.ts | 2 |
| tests/agent/market-shape-synthesis-native-execution.test.ts | 2 |
| tests/agent/concurrency-admin-page.test.tsx | 2 |
| tests/agent/lamp-voc-acceptance-fixtures.test.ts | 2 |
| tests/agent/listing-images-section.test.tsx | 2 |
| tests/scripts/xydc-repair-readiness.test.ts | 2 |
| tests/agent/market-shape-explanation-execution.test.ts | 2 |
| tests/agent/market-shape-explanation-fragment-service.test.ts | 2 |
| tests/agent/service-security.test.ts | 1 |
| tests/agent/agent-run-repository.test.ts | 1 |
| tests/agent/voc-waiting-input-resume.test.ts | 1 |
| tests/agent/analysis-agent-auto-evaluator.test.ts | 1 |
| tests/agent/voc-positioning-execution-service.test.ts | 1 |
| tests/agent/voc-data-source.test.ts | 1 |
| tests/agent/voc-automation-routes.test.ts | 1 |
| tests/agent/analysis-agent-eval-set.test.ts | 1 |
| tests/agent/auth-repository.test.ts | 1 |
| tests/agent/auth-routes.test.ts | 1 |
| tests/agent/traffic-snapshot-read-route.test.ts | 1 |
| tests/agent/traffic-analysis-runtime.test.ts | 1 |
| tests/agent/authenticated-web-mutation.test.ts | 1 |
| tests/agent/connector-credential-http-tracer.test.ts | 1 |
| tests/fixtures/concurrency/fake-provider.ts | 1 |
| tests/agent/help-feedback-ui.test.tsx | 1 |
| tests/agent/helpers/concurrency-admin-browser-harness.tsx | 1 |
| tests/agent/helpers/render-auth-session-gate.tsx | 1 |
| tests/agent/helpers/voc-positioning-fixture.ts | 1 |
| tests/agent/legacy-sync-job-route.test.ts | 1 |
| tests/agent/stage-output-gap-card.test.tsx | 1 |
| tests/agent/stage-output-browser.test.ts | 1 |
| tests/agent/proxy.test.ts | 1 |
| tests/agent/manual-alexa-voc-import-feedback.test.ts | 1 |
| tests/agent/feedback-production-body-limit.test.ts | 1 |

完整日志：.superpowers/sdd/usage-types-after-wiring.log。此处仅完成分类与统计接线修复，没有批量改动其他业务模块。类型不通过不能直接认定上游数据缺失，也不能仅凭构建成功认定没有运行风险。
