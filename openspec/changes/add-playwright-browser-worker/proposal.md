## Why

MVP 对需要浏览器登录态的 Amazon/Alexa 数据只支持已有数据和人工导入。把浏览器自动化放回 Web 或普通分析 Worker 会重新引入进程生命周期、会话秘密和人工认证边界混乱，因此需要单独规划一个隔离的采集 Worker。

本 change 仅登记后续能力，不在当前 MVP 中实现或启用。

## What Changes

- 规划独立的 Playwright Browser Worker 进程，只消费明确授权的浏览器采集任务。
- 规划加密会话存储、管理员重新认证和秘密脱敏边界。
- 登录失效、MFA、验证码或条款确认需要人工介入时，任务进入 `waiting-input`，不得无限重试。
- 成功采集的数据先标准化为带来源、时间和完整性信息的 `DataSnapshot`，再供分析流程使用。
- 保留经校验的人工粘贴或文件导入作为 fallback，不让浏览器能力阻塞全部分析。

## Capabilities

### New Capabilities

- `browser-acquisition-worker`: 隔离执行需要浏览器会话的数据采集，管理人工认证、会话秘密、任务状态、DataSnapshot 输出和人工导入降级。

### Modified Capabilities

无。

## Deferred / Non-Goals

- 本 change 不修改当前 Web、Agent Service、普通 Worker、连接器或部署配置。
- 不绕过 MFA、验证码、站点条款、访问控制或反自动化措施。
- 不使用个人浏览器配置，不把会话秘密暴露给前端、日志、模型提示词或普通分析 Worker。
- 不构建通用网页抓取平台，也不保证所有第三方站点均可自动采集。
- 未经本 change 后续实施、合规审查和验收，不得在生产环境启用。

## Impact

- 后续可能新增独立 Node 进程、任务消费者、加密会话存储和浏览器运行环境。
- 后续需要管理员认证操作、数据源条款审查、秘密管理和受控网络访问。
- 当前 MVP 行为保持不变：缺失浏览器数据时继续使用 `waiting-input` 与人工导入。
