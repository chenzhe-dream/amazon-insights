# VSCode 正式服务启动器设计

## 目标

运营人员打开稳定工作树后，只需运行一个 VSCode 任务，即可启动或安全重启正式 Web 与 Agent。启动器继续调用现有 `scripts/start-agent-stack.mjs`，不改业务启动入口、不构建新版本、不触发分析任务或 Provider。

## 用户入口

- `.vscode/tasks.json` 提供唯一任务：`启动/重启正式系统`。
- 任务调用一个 PowerShell 管理脚本；不提供 BAT 或 Python 包装器。
- VSCode 任务完成后，Web/Agent 作为独立后台进程继续运行，不依赖 Codex 或该任务终端。

## 配置与秘密

- `.runtime/formal-stack.env` 保存正式运行配置，包括 Web/Agent 地址、正式模式、LAN 认证边界和 PostgreSQL 配置。
- `/.runtime/` 必须被 Git 忽略；配置、PID、状态和日志均不得提交。
- 启动器不得打印数据库 URL、Provider 密钥、代理令牌、Cookie 或请求头。
- 初次安装只从现有受保护来源迁移配置；之后启动无需人工逐项设置环境变量。

## 启动和重启流程

1. 读取并严格校验固定配置，要求正式 fake 模式关闭。
2. 校验 PostgreSQL 58258 可查询、3000 无监听，并识别当前受管 supervisor。
3. 若系统未运行，启动现有 `start-agent-stack.mjs prod`。
4. 若系统已运行且无活动 job/stage/attempt/run，只终止该启动器记录并验证归属的 supervisor 进程树，然后重新启动。
5. 若存在活动任务，拒绝重启并显示中文原因，不取消或修改任务。
6. 验证 Web 31900、Agent 31901 和 PostgreSQL 58258；失败时退出非零并指向脱敏日志。

## 进程归属与状态

- `.runtime/state/` 保存 supervisor PID、工作树绝对路径和启动版本。
- “已运行”必须同时满足 PID 存活、工作树匹配、端口归属匹配及 Web/Agent 健康检查通过。
- 不得停止未知进程或仅凭端口号强制结束进程。
- `.runtime/logs/` 保存 stdout/stderr；日志必须遵守现有脱敏合同。

## 验收

- 在配置完整时，单击 VSCode 任务可启动 Web/Agent，三个健康门禁通过。
- 再次单击且 active=0 时，旧受管进程退出并只产生一个新 supervisor。
- active>0、配置缺失、数据库不可用、PID/端口归属不一致时均 fail closed。
- 关闭 VSCode 任务终端和 Codex 后，后台服务仍保持运行。
- 未提交 `.runtime/` 内容，未输出任何秘密，未创建 job/run/stage 或 Provider 请求。
