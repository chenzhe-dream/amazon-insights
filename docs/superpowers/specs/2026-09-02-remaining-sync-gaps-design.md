# 剩余同步缺口修复设计

## 目标

修复最新三 ASIN 同步任务中已经由本地数据流证明的丢数、误报空数据和失败缓存问题；对供应商响应结构未知的缺口只保留安全、有限的诊断，不猜字段、不伪造数据。

## 范围

1. 部分成功阶段发布成功 ASIN 的数据，同时为失败 ASIN 发布逐项缺口原因。
2. 将 `child_sales`、`price_strategy`、`image_remarks` 纳入项目级阶段输出及页面读取。
3. 保留 `SIF_KEYWORD_SCHEMA_INVALID`、`MCP_SCHEMA`、`UPSTREAM_EMPTY` 等有限原因，避免统一压缩为泛化缺口。
4. 子体销量仅在识别到明确空容器时标记 `verifiedEmpty`；有原始子体行但销量字段无效时标记结构缺口。
5. 图片 `connector-failed` 和 `timeout` 不作为永久成功缓存；在新任务中按既有限制重新入队，并保留有限错误类别。

## 非目标

- 不处理 Alexa VOC 变体跳转或 ASIN 别名。
- 不修改 SIF、Sorftime 或图片模型的真实 Provider 请求参数。
- 不根据未知响应猜测新 adapter，不补造价格、销量、评论、类目或图片结论。
- 不触碰正在运行的正式服务、真实凭证、正式 PostgreSQL、部署或真实业务 POST。

## 数据流设计

阶段输出从“阶段全成才有数据”改为“结果与缺口并存”。`partial` 输出携带已成功 ASIN 的原有数据投影，并携带失败 ASIN 的 bounded gap；浏览器读取 `done` 与 `partial` 中的数据。项目级可投影阶段补齐三个已生成但未发布的阶段，沿用现有静态导出结构，不新增存储服务。

诊断原因从每 ASIN 的持久化结果向阶段输出透传，只允许固定 cause code、boundary、operation 和计数/类型桶，不保存响应正文、URL、凭证或任意字段值。

子体销量解析同时记录是否识别到容器、原始行数和有效销量行数。只有“识别到容器且原始行数为零”才是可信空；原始行存在但有效销量为零属于 schema gap。

图片队列只把 `ready` 视为可长期复用。失败或超时槽位在后续新任务中重新进入现有受限队列；同一任务的重试预算和并发治理保持不变。

## 验收

- 一个阶段两项成功、一项 schema failure 时，页面能展示两项成功数据及一项精确缺口。
- `child_sales`、`price_strategy`、`image_remarks` 都生成项目输出/hash，并可被页面读取。
- 已知 schema cause 不再被覆盖成 `UPSTREAM_EMPTY` 或通用 `connector-failed`。
- 有子体但缺少销量字段时不得显示“确认无子体销量”。
- 图片失败槽位可在新任务重试，成功槽位仍复用。
- 所有生产修改都有先失败后通过的定向测试；最终 build、changed lint 和 diff-check 通过。
