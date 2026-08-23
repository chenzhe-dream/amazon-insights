## Why

当前 ASIN 同步在页面刷新后会丢失任务身份并可能重复 POST，图片备注的长耗时会阻塞 traffic 与基础报告，runner 还会在 build 后启动旧版 3000 服务；同时页面主要读取构建期 TypeScript 数据，已完成的采集不能稳定地在当前 31900 实例中动态可见。业务正在局域网使用，需要先把现有同步链路稳定为可恢复、可去重、局部失败透明且由正式 supervisor 管理的最小闭环。

## What Changes

- 为同步任务建立稳定作用域和幂等指纹：认证组织、项目、marketplace 与规范化后的 ASIN 集合相同且已有 active job 时，返回原 job，而不是创建重复 Worker。
- 将当前 jobId 写入 URL，并在刷新后只 GET 原任务；浏览器关闭或页面卸载不取消后台 Worker，登录 cookie 继续承担身份恢复。
- 将 traffic 前移到基础数据链路，在基础页面可用后再让图片备注以小并发后台继续；Alexa VOC 保持 manual，不进入自动完成门槛。
- 隔离单 ASIN、单模块和单图片失败，公开 `ready`、`upstream-empty`、`timeout`、`connector-failed`、`pending`、`manual` 状态；部分缺口不得伪装为完整成功，也不得抹掉其他已成功数据。
- 移除 sync runner 对旧 `start-team-server.ps1`/3000 路径的调用。job 只生成构建结果和受控 reload 请求，由正式 launcher/supervisor 独占当前 31900 Web 子进程的替换权，不派生第二套 Web 服务。
- 以 traffic 为 PostgreSQL 动态读取 tracer：复用现有 traffic snapshot 存储，采集结果在 PostgreSQL 落盘并由页面经 Agent API 动态读取；迁移期保留有限的 legacy fallback，但新鲜 PG 数据无需重新 build 即可显示。
- 为不依赖 VOC 的“开始全自动分析”创建受认证项目约束的同步专用 canonical run：只创建并由现有 sync job 驱动 `traffic-analysis` 生命周期，不排入通用 analysis Worker；页面、job 与 PostgreSQL traffic snapshot 使用同一 projectId/runId。
- 为真实 provider 增加有界、脱敏的故障分类与安全降级：DNS/TLS/代理/HTTP/RPC/合法空响应必须可区分，传输失败不得伪装为 `upstream-empty`；主路径不可用时保留已成功数据和原 job，停止自动重试，并允许管理员在 provider 恢复后从失败阶段显式续跑。
- 在并发管理面板增加 SellerSprite、SIF、Sorftime 的混合凭证管理与逐连接器探测：最高管理员可加密保存、替换或撤销托管凭证，服务器环境变量保留为只读启动备用；页面永不回显秘密，真实同步在所需连接器未配置或未通过探测时不得创建无效任务。
- 为诊断能力上线前遗留的错误 `upstream-empty` 提供显式、可预览的离线重分类，只处理没有成功响应或 schema-valid 空结果证据的终态 job，并诚实标记为 `pending/LEGACY_UNVERIFIED`；修复后显式续跑必须按 job 的逐 ASIN 未完成状态选择目标，不得被旧构建期占位文件跳过。
- 按 Slice 1→4 交付并设置部署门禁：定向测试通过、无 active sync job、fresh build 成功后，才允许在业务空档受控刷新当前 31900；不得触发 3000，31901/58258 在普通数据刷新中保持运行。
- 非目标：不扩展登录、Cloudflare、生产审计、hostile-review 循环，不一次迁移全部静态数据模块，也不改动 Alexa 的人工采集策略。

## Capabilities

### New Capabilities

- `resumable-sync-pipeline`: 规定同步任务的恢复与去重、阶段排序、局部失败和逐 ASIN 状态、正式 Web reload 所有权，以及 traffic 的 PostgreSQL 动态读取 tracer。

### Modified Capabilities

无。当前仓库尚无已归档到 `openspec/specs/` 的对应主规格；旧 `build-standalone-agent-workflow` 变更保持关闭范围，不在本变更中重新打开。

## Impact

- 前端与协议：`app/asin-sync-funnel.tsx`、页面 URL 状态、`shared/agent-contracts.ts`、local-data Agent API。
- 同步运行时：`app/lib/sync-server.ts`、`scripts/lib/sync-job-store.mjs`、`scripts/run-asin-sync-job.mjs`、逐 ASIN 状态与图片备注采集脚本。
- 服务管理：`scripts/start-agent-stack.mjs` 及其定向测试；sync job 不再直接调用旧版团队服务器启动脚本。
- 持久化与动态读取：复用 PostgreSQL traffic snapshot repository，并新增非破坏性 migration 0015 让 run stage 可准确表达 `partial`；在 Agent Service 增加受组织与项目作用域保护的读取路径，并让 traffic 页面优先消费动态数据。
- 运维：部署与真实 smoke 必须保护 31900/31901/58258，不输出 provider secret、数据库 URL、请求头或完整 provider body。
- 正式启动门禁：正式 launcher 检测到本地 fake provider 模式时必须在创建任何子进程前拒绝启动；测试与开发 fixture 可显式使用 fake，但不得混入真实验收。
- 故障恢复：新增 provider 传输诊断、连接器降级状态和受控阶段续跑；备用路径不得注入 fake/cache 数据冒充本次真实采集结果，也不得绕过相同作用域的单 Worker 约束。
- 数据源运维：复用现有 connector credential、probe 与审计后端，在管理面板补齐最高管理员入口、启动前门禁和遗留状态离线修复；任何客户端响应、日志或测试证据都不得包含凭证明文。
