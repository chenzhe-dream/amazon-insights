# 商品同步进度和有界恢复

**Goal:** 修复西柚终态误判及父体失败漏报，限制 Sorftime 可选详情耗时，复用成功数据补采失败项。

**Architecture:** 保留现有 authority、缓存、provider governor 和发布链。完成记录只豁免 heartbeat 过期，不豁免 run/lease/worker 校验；父体发现覆盖与子体订单计数分开。Sorftime 请求共享总预算，可选详情使用更短预算，并输出可持久化进度。恢复保持单次有限处理，不 force 全组。

**Authorization:** 交接明确允许自审后安全实施及受控发布，无需重复审批。当前工作树已从干净旧祖先快进到 e7fe683。实查目标 job completed，未中断任何真实任务。

**Constraints:** 不直接 SQL 改状态；不绕过 idle；保留正式 generated、项目、缓存与数据 artifact；不将 RPC_ERROR/超时/空响应标成成功。

- [x] 西柚 `xydc-order-job-progress`：增加 completed/partial 超过45秒但父任务活动的回归；保留取消、租约替换、旧窗口回归；修复后运行真实 PG 测试。
- [x] 西柚进度契约/组件：报告请求商品总数及未发现父体，4/4仅说明已发现子体；测试混合成功/失败及全部失败。
- [x] Sorftime variant runner：测试总deadline、详情短超时、已取得子体保留及逐项进度；通过后接入实际调用和阶段消息。
- [x] 西柚补采：测试成功缓存不请求、失败父体和失败子体仅有限重试、取消传播和旧可用缓存保留。
- [x] 独立审查、相关回归、build、改动文件lint、diff检查；记录证据后备份最新正式数据，经管理器idle gate发布并验证健康与数据散列。
