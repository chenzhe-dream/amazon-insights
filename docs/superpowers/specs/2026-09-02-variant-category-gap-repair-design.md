# Variant 与 Category 数据缺口修复设计

## 目标与证据边界

本设计只修复 2026-09-02 VOC 输入缺口清单已经证实的两个 P0：

1. `scripts/run-asin-sync-job.mjs` 在 Sorftime `child_sales` 阶段把变体子步骤发给 `npm run variant:sync`；该脚本实际是 SellerSprite builder，却收到 `SORFTIME_ASINS`，因此三条目标 ASIN 均没有生成 Sorftime 变体结构。
2. `scripts/build-sorftime-category-trend.mjs` 在任一 ASIN 的 `product_detail.node_id` 或任一 node 的 `category_trend` 失败时立即抛出，剩余 ASIN 不再处理，且 runner 只能得到阶段级失败，不能得到逐 ASIN 的有界结果。

不处理清单中仍需 Provider 证据的 SIF、reviews、child-sales、price 或 FBA 问题。本次不调用真实 Provider、不发送 POST、不部署、不重启、不生成业务数据、不读取或修改凭证、不修改 MCP/Provider adapter，也不借 catalog 文本类目猜测 `node_id` 或伪造 category 趋势。

## 方案一：修正 Sorftime variant command contract

runner 保持既有 `connector: "sorftime"`、`stage: "child_sales"`、目标 ASIN cohort、`SORFTIME_ASINS` 和 `SORFTIME_MARKETPLACE`，只把变体子步骤的 label/命令改为 package 中已经存在且直接运行 `scripts/build-sorftime-variant-data.mjs` 的 `variant:sorftime:sync`。为避免再次出现 label、npm script 与环境变量漂移，runner 导出一个纯 command-spec helper；现有 `tests/scripts/asin-sync-job-postconditions.test.mjs` 用 fake provider 捕获该对象，并断言完整契约。测试不启动 child process，也不调用 Provider。

该修复不改变 `child_sales` 的 stage id、Sorftime connector provenance、后续 `child-sales:sync`、diagnostic 合并或 postcondition。SellerSprite 的 `variant:sync` package script 保留，其他入口仍可显式使用。

## 方案二：Category 逐 ASIN隔离与有界汇总

`collectSorftimeCategoryRecords` 保持两段式流程：先逐 ASIN 解析真实 `product_detail.node_id`，再按真实 node 拉取趋势。两段都改为局部收敛：

- 一个 ASIN 无法解析真实 `node_id` 且没有同 job scoped evidence 时，写入现有 `SorftimeCategoryTrendRecord` 形状的 `error` 记录；`nodeId` 留空，record key 使用明确的 ASIN failure key，不把 ASIN 或 catalog 类目冒充 node。记录只含该 ASIN、空趋势数组与固定 `statusMessage` reason code。
- 一个已解析 node 的 `category_trend` 调用失败且没有同 job scoped evidence 时，为该 node 写 `error` 记录，并为绑定到该 node 的每个 ASIN产生独立的安全 diagnostic；随后继续处理其他 node。
- Provider 正常返回但没有可用 volume 时继续写 `empty`，同时写固定 `statusMessage: "UPSTREAM_EMPTY"`；不根据 catalog 文本构造趋势。
- error 的 `statusMessage` 只取现有 allowlist diagnostic 的 `causeCode`（如 `CONNECT_TIMEOUT`、`MCP_SCHEMA`、`PROVIDER_DEGRADED`、`UNKNOWN_TRANSPORT`），不落原始异常消息、response body 或凭证。`product_detail` 有响应但缺 `node_id` 按既有 `schema/MCP_SCHEMA/product_detail/consumer-shape` 表达。
- collector 返回 records、真实 `nodePlan` 与逐 ASIN diagnostics。CLI 始终先写出全部已结算 records，再逐条输出 `formatProviderDiagnosticLine`；只要存在 error diagnostic 就以非零退出，只有 ready/empty 时以零退出。

runner 现有 child-output parser 会把每条 diagnostic 归并为相应 ASIN 的 `timeout` 或 `connector-failed`；持久化 readiness 仍把成功 node 的 ASIN 标记 `ready`、empty 标记 `upstream-empty`。因此混合 batch 可保留成功 ASIN，同时命令的非零退出和既有 category `CONNECT_TIMEOUT` 终态规则保持一致。不会修改 `scripts/lib/sorftime-mcp-client.mjs`、`scripts/lib/provider-diagnostics.mjs` 或任何 adapter。

## 测试与验收

- fake command contract 精确断言 Sorftime variant 使用 `variant:sorftime:sync`、`SORFTIME_ASINS`、Sorftime connector 与 `child_sales` stage，且不出现 SellerSprite env。
- category fake `callTool` 令第一个 ASIN 缺 `node_id`、第二个 ASIN返回可用 node/trend；断言第二个仍 ready，第一个有 `MCP_SCHEMA` error record 和逐 ASIN diagnostic，且没有虚构 node。
- category fake `callTool` 令一个真实 node 趋势超时、另一个 node 成功；断言失败 node 的每个 ASIN均有 `CONNECT_TIMEOUT` diagnostic、成功 node 保留 ready、没有第三次 retry、collector 不因局部失败 reject。
- empty fixture 断言空趋势记录使用现有 `empty` schema 和 `UPSTREAM_EMPTY`，不产生 error diagnostic。
- focused tests、changed-file lint、生产 build、`git diff --check` 与独立 review 全部通过；任何真实 Provider、POST、部署、重启、生成数据或凭证访问均为验收失败。

## 自审结论

设计只有两个可独立审查的 P0，分别限制在 runner command contract 与 category builder 批处理控制流。它复用既有 package scripts、record schema、provider diagnostic allowlist、runner postcondition 和现有测试文件；没有 adapter 变更、类目推断、数据生成或架构扩展，也没有未决占位符。
