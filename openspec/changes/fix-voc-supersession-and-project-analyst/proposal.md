## Why

2026-09-16 正式 VOC 记录证明：新输入唤醒定位时会新增周期，但旧运行调用继续占用 Worker 直到 Provider 超时；历史项目没有可信分析人展示。用户要求先修复衔接，再显示谁发起分析。

## What Changes

- 新输入接替运行中定位时，事务内撤销旧尝试租约，保留历史结果和输入；Worker 通过既有心跳停止旧调用，迟到结果不能覆盖新周期。
- 历史项目新增只读“最近分析人”，以组织内服务端分析记录及账号为依据；无可信记录显示“未记录”，不使用可编辑创建人冒充分析人。

## Capabilities

### New Capabilities
- `voc-supersession-and-project-analyst`: 定位周期接替与项目分析人展示。

### Modified Capabilities

## Impact

限定任务存储、定位唤醒、项目列表读取及展示；补 SQLite/PostgreSQL、Worker 中断、归属权限和列表回归。保留 1.1.3 结构规则及其他模块，不改变上游模型或延长超时。
