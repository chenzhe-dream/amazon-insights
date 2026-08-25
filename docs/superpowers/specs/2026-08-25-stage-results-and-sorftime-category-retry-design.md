# 阶段结果增量展示与 Sorftime Category 有界重试设计

## 背景与边界

本设计扩展既有 [stabilize-resumable-sync-pipeline OpenSpec](../../../openspec/changes/stabilize-resumable-sync-pipeline/proposal.md) 及其 [设计](../../../openspec/changes/stabilize-resumable-sync-pipeline/design.md) 和 [规格](../../../openspec/changes/stabilize-resumable-sync-pipeline/specs/resumable-sync-pipeline/spec.md)。它在同一验收批次内交付两个可独立实现、可独立回退的切片：阶段结果首次可见性，以及 Sorftime category 的一次有界超时重试。

本次不改变同步 job/run 的创建模型、认证模型、最终 build/publication、现有 1.5 秒 job GET 轮询、SellerSprite、SIF、图片或 VOC 行为；不增加 SSE、WebSocket、per-stage build、per-stage reload、provider probe 或新的启动机制。最终 build/publication 继续生成和发布完整静态产物，但不再是已完成模块首次可见的前提。

## 方案选择

1. **推荐：受作用域保护的只读 stage-output API。** 页面继续轮询 job；每当一个阶段进入终态，仅拉取该阶段的持久化、规范化投影并局部渲染。它复用已有 Agent 权限链、持久化 job 和 1.5 秒节奏，不需要让浏览器读取生成文件，也不需要新的事件通道。
2. **仅等待最终 build/reload。** 改动最少，但仍把首次可见性绑在全部阶段和发布完成之后，不能满足模块级增量展示。
3. **SSE/WebSocket 推送阶段数据。** 首次可见性也可达成，但需要新连接、断线恢复、授权失效和背压语义；相对本次目标扩大了运行时面，故不采用。

## Slice A：模块级增量展示

### 只读 API 与授权

新增受现有 Agent session 认证保护的只读端点：`GET /v1/projects/:projectId/runs/:runId/sync-jobs/:jobId/stages/:stage/output`。`projectId` 与 `runId` 是请求路由选择器，不是可信的归属声明；客户端不能覆盖 tenant 或 organization，服务端也绝不把任何路径值当作授权依据。服务端从认证 principal 得到 `organizationId`，加载该组织范围内的 project、该 project 内的 run 和 job 记录，并交叉校验所有持久化 ID；只有以下所有条件成立才返回结果：

- principal 有权访问该 organization 内的 path project，且 path run 属于该 project；
- job.organizationId、job.projectId、job.runId 分别与 principal organization、path projectId、path runId 精确一致；
- `stage` 是该 job 的允许阶段，且该阶段已到达可投影终态；
- 输出记录属于同一 job、project、run、organization 和 stage。

任一不匹配一律按现有安全的未发现/未授权语义处理，不泄露 job 是否存在、跨租户数据、源文件路径、原始 provider body、凭证或内部诊断。端点不写 job、不触发生成器、不触发 build/reload，也不创建 job/run/stage/attempt。

成功响应是严格的规范化 `StageOutputProjection`：`jobId`、`projectId`、`runId`、`stage`、`stageStatus`、单调 `jobVersion`、单调 `outputVersion`、`contentHash`、`updatedAt`，以及二选一的 `data` 或固定 `gap`。`data` 只包含现有页面消费的模块字段；`gap` 只包含有限状态和原因码（例如 `timeout/CONNECT_TIMEOUT`），不含自由文本。阶段只有在其结果已持久化后才能被标记为可投影终态；因此终态成功响应不会指向尚未写入的数据。历史或没有 canonical project/run 关联的 job 不使用此端点，保持既有页面与 legacy fallback 行为。

### 数据流与页面规则

页面保持现有每 1.5 秒对同一 `syncJob` 的 GET，不增设并行定时器。它维护每个 stage 的最后观察状态和 `(jobVersion, outputVersion, contentHash)`：首次看到 `done`、`partial` 或 `failed`，或随后版本升高时，对该 stage 发起一次 stage-output GET。请求完成后，只更新该 stage 对应模块；不刷新整页，不重新请求已确认版本，也不调用任何 provider。

模块按同步阶段完成顺序独立可见：keywords、reviews、sales、FBA、listing、category、traffic。页面采用现有模块到 stage 的映射；其中 sales 保持既有销售阶段的聚合投影，而不是把一个 UI 模块误当成新的 runner stage。某个模块成功后立刻保留其最近通过 scope 与版本校验的内容；后续其他模块失败、job 变为 `completed-with-gaps` 或 publication pending 都不得清空、遮挡或降级该成功模块。

`partial` 或 `failed` 的 stage-output 响应只渲染该模块固定的缺口状态与可安全展示的原因码。未终态模块保持等待态。若轮询暂时失败，页面保留已验证数据并在下一个既有 1.5 秒 job 轮询周期重试观察；不做全局 reload。首次有效数据必须在最终 job 终态、build 和 publication 之前即可显示。

客户端缓存键为 `(organizationId from session, projectId, runId, jobId, stage, contentHash)`，其值同时绑定 `jobVersion/outputVersion`。客户端还必须将响应的 projectId/runId/jobId/stage 与当前 URL/recovered scope 逐项比较；收到不同 job/scope、较旧版本或不匹配 contentHash 的响应必须丢弃。URL scope 变更、登出或 job 切换时清除旧 scope 的内存引用。服务端以持久化版本和 content hash 为真源，不能依赖浏览器缓存正确性。

### 最终 publication 对账

runner 仍只在既有最终节点生成一次完整 build 和受控 publication request，supervisor 仍是唯一 Web 发布者。最终产物必须由与 `StageOutputProjection` 相同的已持久化模块源生成；publication acknowledgement 的 artifact/version 与该 job 的最终 `jobVersion` 对账。若完整静态产物缺失某个已增量展示且同版本的模块，publication 失败并保留增量结果与固定发布错误，不得用旧产物覆盖页面。页面在 artifact 已匹配时可将静态结果与相同 contentHash 视为同一版本；不匹配时以受作用域保护的增量投影维持展示，直到既有 publication 流程完成。

## Slice B：Sorftime category 的一次 CONNECT_TIMEOUT 重试

### 状态机与治理

该规则只适用于同一原 job 的 Sorftime **category** dispatch，且仅在第一次物理请求被统一诊断分类为 `CONNECT_TIMEOUT` 时触发。首次 dispatch 和自动重试都是独立的 physical dispatch：每次都必须先通过现有 resource governor 取得许可，并在实际发出请求时准确记录一次 `concurrency_physical_attempts`。不得在 governor 外直接调用 Sorftime，也不得把逻辑 retry 当作零成本的同一次 attempt。

第一次 `CONNECT_TIMEOUT` 后，category work item 保持同一 job/run/stage/scope，记录第一条尝试并最多排入一次 `transient-retry`。重试成功时写入同一持久化 category 输出，标记 ready，并继续该 job 原有的后续处理。非 `CONNECT_TIMEOUT` 失败不获得本规则的自动重试，继续沿用现有失败投影。

第二次 `CONNECT_TIMEOUT` 后立即 fail-closed：该 job 的 category 工作项标记为终态缺口 `timeout/CONNECT_TIMEOUT`，停止该 job 中尚未发出的 Sorftime category 请求，不再调度第三次 physical dispatch；已经成功的其他 ASIN/模块结果保持可见。阶段归并为 partial/failed 时，stage-output API 返回同一固定缺口，不输出原始传输细节。该封闭规则不改变 SellerSprite 或 SIF 的重试、治理或错误策略。

### 显式续跑

在 provider 恢复后，用户可通过既有“续跑失败阶段”能力显式续跑**原 job 的 category 阶段**。服务端必须校验原 organization/project/run/job scope、该 category 缺口及没有活动 Worker；续跑只重置同一 job 内 category 的可执行状态并保留完整 attempt trail。它不得创建新的 sync job、run、run stage 或不相关模块工作项，也不得用 provider probe 代替实际授权的续跑。新的显式续跑周期重新受同一 governor 和上述一次自动 `CONNECT_TIMEOUT` retry 上限约束。

## 测试与验收

实现时新增定向单元/集成 fixture，不在本设计阶段执行：

- 以既有 1.5 秒 job 轮询驱动，依次让 keywords、reviews、sales、FBA、listing、category、traffic 进入终态；每个模块都在最终 build/publication 前局部可见，首次可见过程中全局 reload 为 0。
- 成功模块随后遇到其他模块失败、job `completed-with-gaps`、publication pending/failed 时，内容仍可见且未被缺口覆盖；跨组织、跨项目、跨 run、跨 job 或陈旧版本 stage-output 均不可读取或不可应用。
- stage-output 只读：断言 GET 不产生 provider 调用、build、reload、job/run/stage/attempt；缓存命中与版本相同不产生重复模块更新；最终 artifact 与每个已展示模块的同版本 content hash 一致。
- Sorftime category 的瞬态 `CONNECT_TIMEOUT` fixture：第一次与第二次都形成精确治理/physical-attempt 记录，第二次成功，category ready，后续阶段继续。
- 永久 `CONNECT_TIMEOUT` fixture：恰好两次 physical attempts、没有第三次 dispatch、category 显示固定 `timeout/CONNECT_TIMEOUT` 缺口，其他已成功模块保持可见。
- 对永久缺口执行一次授权的 resume：仅原 job 的 category 被选中，jobId/runId/stageId 均为零新增，attempt trail 可审计；没有自动 provider probe、没有新 job/run，也没有 SellerSprite/SIF 行为变化。

## 自审结论

已检查文档：没有占位符或未决条目；两个切片的 API、权限、版本、错误、终态对账和验收边界相互一致。范围明确排除了实现、测试执行、部署、provider/job/browser 操作，以及事件通道与其他连接器策略变更；因此可在用户书面确认本 spec 后再进入 implementation planning。
