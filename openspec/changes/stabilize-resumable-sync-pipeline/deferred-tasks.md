# Deferred tasks

以下事项不属于当前 OpenSpec 的业务直接阻断，不影响 Slice 1 验收；后续单独排期：

- 将浏览器测试中剩余的固定等待逐步替换为事件、响应或可观察状态驱动的同步，降低测试时序波动。
- 直接围绕生产页面的 restart coordinator 增加集成级测试，减少测试 harness 对协调逻辑的重复表达。
- 清理已失效或语义重叠的 `onSyncDismiss`/终态清理回调边界，并保持页面终态所有者为唯一 URL 清理与 reload 决策方。
- 整理忽略提交的 Slice 1 历史报告重复段落；保留最终证据，不影响源代码或验收结果。
- 加固 reload request 在已应用但尚未写入 applied archive 时进程崩溃的恢复语义，避免 processing 文件在极端窗口被重复消费。
