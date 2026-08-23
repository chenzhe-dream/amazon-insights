## Context

动机见 [proposal.md](proposal.md)，可验收行为见 [specs/resumable-sync-pipeline/spec.md](specs/resumable-sync-pipeline/spec.md)。当前 live 系统由 31900 Web、31901 Agent Service 和 58258 PostgreSQL 组成；Agent 的同步路由创建 `data/sync-jobs/*.json` 并派生 `scripts/run-asin-sync-job.mjs`。页面只用组件内 ref 防止单次挂载重复启动，jobId 不进入 URL，因此刷新会丢失身份。runner 串行执行图片备注后才执行 traffic，并在 build 后调用旧 PowerShell 路径启动另一套默认 3000 Web。

已有 PostgreSQL `traffic` data snapshot、SIF traffic snapshot task、run/project/organization 权限链和 `run` URL 参数可复用；现有业务页面仍主要导入构建期 TypeScript 数据。live worktree 还有采集生成文件和运行 WIP，所以实现必须在独立代码 worktree 中完成，只把经审查的显式提交部署到 live。

## Goals / Non-Goals

**Goals:**

- 在保持单一正式 Agent/Worker 所有权的前提下，让同步任务跨刷新恢复并对并发 POST 去重。
- 把“基础可用”和“图片增强完成”拆成两个时间点，保证 traffic 与基础报告不等图片。
- 将结果从阶段级二元成败细化为逐 ASIN、逐模块的稳定状态，并保留已成功数据。
- 彻底断开 sync runner 与旧 3000 启动路径，由正式 supervisor 管理 31900 Web 发布。
- 以有 project/run 作用域的 traffic 链路证明 PostgreSQL 写入与页面动态读取，无需一次迁移全部数据。
- 让最高管理员在同一管理面板安全维护并验证真实数据源，同时阻止已知不可用的连接器创建无效真实任务。
- 在不调用 provider、不删除产物的前提下修复诊断上线前遗留的错误空结果分类，使后续显式续跑真正选择失败 ASIN。

**Non-Goals:**

- 不把当前 JSON sync job store 全量迁移为 PostgreSQL 队列，也不重写已有通用 analysis job lease 系统。
- 不并行化所有第三方连接器；除图片小并发外，先保持可预测的基础阶段顺序。
- 不自动化 Alexa，不迁移图片、FBA、VOC 或其他所有页面数据为动态读取。
- 不改变登录产品设计、Cloudflare 部署、组织模型或生产审计范围。
- 不自动迁移全部历史 job，不自动轮换环境变量凭证，也不在凭证保存或探测后自动启动真实同步。

## Decisions

### 1. 用规范化作用域指纹做过渡期幂等，而不重写任务队列

同步启动请求增加可选 `projectId`、`runId`；organizationId 必须从 Agent 已认证 principal 推导，不能信任客户端。服务端将 ASIN 去重、排序并与 organizationId、projectId（无项目时使用固定空作用域）、marketplace 组成 canonical JSON，再计算 SHA-256 指纹。job 记录持久化该作用域、指纹及关联 run。

31901 是唯一同步启动入口，因此在 Agent 进程内按指纹串行化“扫描 active job → 复用或创建 → 启动 Worker”临界区；Agent 重启后首次请求通过扫描持久化 job 恢复索引。active 集合固定为 `queued`、`running`、`base-ready`、`enriching`。响应增加 `reused`，现有调用方仍可读取原有字段。

备选方案是立即把整个 file job store 并入 PostgreSQL lease 队列。该方案长期更强，但会同时改 runner、任务模型、重试和迁移，超出本次稳定化范围。过渡方案依赖“31901 单实例”运维不变量；后续多 Agent 部署前必须迁移为数据库唯一约束或租约。

### 2. URL 是恢复指针，sessionStorage 仅作同浏览器辅助

页面使用独立的 `syncJob` 查询参数保存 jobId，并继续使用现有 `run` 参数保存分析 runId。组件挂载时先解析 jobId：存在时只 GET job，校验 organization 由服务端授权、project/run、marketplace 与规范化 ASIN 集合匹配后恢复轮询；不存在且用户明确触发同步时才 POST。sessionStorage 可以保存每个 pathname/project 的最近 jobId，但不能覆盖 URL，也不能在校验失败时自动启动新 job。

`runAnalysis` 调整为保留 `/v1/local-voc` 返回的 canonical projectId/runId，并把它们传给同步启动；普通“补齐缺失数据”若没有 run 上下文，仍可执行 file-backed 同步，但不会假装完成 PostgreSQL traffic tracer。

### 3. 将 job 生命周期与逐 ASIN 模块结果分开

job 顶层状态采用 `queued → running → base-ready → enriching → completed|completed-with-gaps|failed`。`failed` 只用于 runner/存储/构建等使流水线无法继续的基础设施失败；单连接器、单 ASIN 或单图失败最终进入 `completed-with-gaps`。

`asinProgress[asin][module]` 从自由字符串收紧为带状态、有限原因码和更新时间的记录；对外状态只允许 `ready`、`upstream-empty`、`timeout`、`connector-failed`、`pending`、`manual`。阶段状态由逐 ASIN结果归并为 pending/active/done/partial/manual/skipped/failed，不能用命令退出码覆盖已验证的持久化结果。日志继续使用现有 redaction，并对新增 reason/detail 复用同一清理边界。

### 4. 基础阶段先终态化，图片备注随后小并发增强

基础 cohort 保持确定顺序：catalog → keywords → reviews → sales_trend → child_sales → price_strategy → fba → listing → category → traffic。每个阶段逐 ASIN捕获连接器调用和持久化后置条件；某个 ASIN 失败后继续处理同批其他 ASIN及后续独立阶段。基础 cohort 全部达到终态后设置 `baseReadyAt` 并进入 `base-ready`。

图片备注随后进入 `enriching`，默认最多同时处理 2 张图片，每张单次上限 90 秒；单图超时或连接器失败写入所属 ASIN 结果后继续队列。首版不增加自动重试，避免同一故障成倍延长业务等待。Alexa 从 job 创建时即标记 `manual`，runner 不自动调用 Playwright，也不参与基础或最终完成判定。

备选方案是让所有模块并行。它能缩短理论耗时，但会提高第三方限流、日志交错和共享 TypeScript 文件写冲突风险；本次只解决已证实的图片阻塞。

### 5. supervisor 通过持久 reload request 独占 31900 发布

删除 runner 中 `restartTeamServer` 及对 `start-team-server.ps1` 的调用。需要发布构建期数据时，runner 只运行 fresh build；成功后向忽略提交的 runtime 目录原子写入版本化 reload request，包含 jobId、build 完成时间和目标 Web 配置标识，不包含命令行、环境值或凭据。

`start-agent-stack.mjs` 作为正式 supervisor 监看请求并拥有 Web 子进程句柄。它验证请求属于当前 worktree/配置，只替换现有 Web child，并等待 31900 health=200；31901 和 58258 不重启。请求失败或 supervisor 不存在时，job 记录 `publication=pending`，绝不调用旧脚本或启动第二个监听。部署代码版本时仍执行更严格的零 active job 门禁，并在业务空档受控重启需要更新的正式进程。

选择文件式 request 而不是新增本地控制 HTTP 端口，是为了避免新的认证面与 Windows 信号差异；请求必须原子写入、幂等消费，并在成功或明确失败后归档。

### 6. traffic tracer 复用 run-scoped PostgreSQL snapshot

当 job 带有通过授权校验的 projectId/runId 时，traffic 阶段调用现有 repository-backed SIF traffic snapshot task。该 task 已按 run 幂等并保存来源、时间、marketplace、ASIN 集合和 content hash；若 analysis pipeline 已创建快照，sync job 复用它而不重复抓取。首版不新增 PostgreSQL migration。

Agent 增加 run-scoped traffic snapshot 读取合同，按 request principal 的 organizationId 校验 run/project 所属关系后返回适合页面消费的 normalized payload。页面的 traffic 数据容器在打开或轮询时动态 GET 当前 `run` 的快照，并把该 payload 注入 traffic 视图；静态 TypeScript 数据只在 404/尚未生成时作为标注为 legacy 的 fallback。PG 快照一旦可用即覆盖 fallback，所以 traffic 更新不触发 build/reload。

没有 canonical run 的旧入口继续执行 legacy traffic 同步，状态中明确 `dynamicSnapshot=pending`；这保留现有可用性，但不计入 tracer 成功验收。

### 7. 每个 Slice 都是可回退的独立提交与审查门

Slice 1 只交付 resume/dedupe；Slice 2 交付阶段排序、逐 ASIN结果和图片隔离；Slice 3 删除旧 3000 路径并加入 supervisor reload；Slice 4 接通 PostgreSQL traffic 动态读取。每个 Slice 必须先写失败测试，再做最小实现、定向测试、build 与独立审查，禁止使用 `git add .`。

回退时优先回退当前 Slice 的页面或动态读取入口。Slice 3 的“runner 不得启动旧 3000”是单向安全约束：即使 supervisor reload 出现问题，也只能降级为 publication pending，不能恢复旧启动路径。Slice 4 可关闭动态读取并回到标注 legacy fallback，已写 PostgreSQL 快照保留不删。

### 8. provider 主路径失败时采用可观测降级与显式阶段续跑

detached runner 不再丢弃子进程的全部输出。Worker 只捕获固定大小的 stdout/stderr 尾部，并在统一 redaction 后提取白名单诊断 `{connector, stage, asin, failureKind, causeCode}`；不持久化完整 URL、请求头、请求体、环境变量或自由文本秘密。各生成器把传输失败作为非零/结构化失败返回，readiness 只能在“请求成功且响应通过 schema 校验”后判定 `upstream-empty`。

主路径优先修复统一的 detached Node 网络边界（代理、CA、DNS/dispatcher 和环境继承），不得在每个生成器内各自增加不一致的网络补丁。管理面板的连接器状态必须来自实际 credential resolver 与最近安全诊断，不能仅因 `connector_status` 快照缺失就宣称凭据未配置。

备用路径不是第二个数据 provider，也不是 fake fallback。连接器在同一任务达到失败门槛后进入 `provider-degraded`：停止该连接器的后续自动请求，保留原 job、已成功阶段、生成记录和 PG 快照，其余独立模块可继续终态化。管理员可在恢复后显式续跑；续跑仅选择失败/未完成阶段，走原有 scope fingerprint 与单 Worker 临界区，并留下新的 attempt 记录。首版不做自动重试、跨 provider 自动切换或后台无限探测。

真实验收分两道门：先用本地假 MCP/provider 完整 spawn runner，覆盖成功及 DNS/TLS/治理/HTTP/RPC/空响应分类；再受控部署并对已保存的三个全新 ASIN 工作区只显式重试一次。若仍失败，立即停止新请求并依靠新增安全故障码继续诊断，不创建第三个真实 run。

### 9. 管理面板采用托管凭证优先、环境变量只读兜底

复用现有组织级 connector credential repository、加密器、审计记录和 `GET/PUT/DELETE /v1/connectors`、`POST /v1/connectors/:connectorId/probe` 合同，不新增浏览器可读的秘密接口。管理面板为 SellerSprite、SIF、Sorftime 各显示来源、是否已配置、最近探测结果和有限故障码；只有最高管理员可以录入、替换、撤销或探测。输入框始终为空，保存成功后只返回版本和更新时间，页面、日志、错误与缓存均不得回显秘密。

托管凭证存在且 active 时优先使用；没有托管记录时可读取服务器环境变量作为只读兜底。环境变量来源只能显示“服务器已配置”，不能从页面读取、覆盖或撤销。这样既保留现有部署兼容性，也让日常轮换无需重启 Agent。备选的纯环境变量方案维护成本高，纯托管方案又会让现有安全配置在升级时突然失效，因此采用混合方案。

真实同步启动前根据将要执行的自动阶段计算所需连接器。任一所需连接器未配置、最近显式探测未通过或处于 provider-degraded 时，页面和服务端都拒绝创建新 job，并给出连接器名称与安全故障码；保存凭证或探测成功本身不得自动 POST 同步。浏览器校验只是体验层，服务端门禁是最终权威。

诊断上线前的历史 job 可能在没有成功响应证据时写成 `upstream-empty`。系统提供最高管理员专用的“预览→确认应用”离线修复，只允许同组织终态 job，并且只选择生成于诊断版本前、没有成功响应或有效 schema 空结果证据的 ASIN 模块。由于缺少证据不能反向断言具体传输故障，应用时统一重分类为 `pending` 与有限 `LEGACY_UNVERIFIED` 原因；预览携带 job 版本，apply 必须匹配以避免覆盖并发变化。修复保留 jobId、scope、attempt、ready/manual 结果、生成文件和 PG 快照，不调用 provider。显式续跑的 ASIN 选择以 job 的 `connector-failed|timeout|pending` 为权威，即使旧构建期占位文件存在也不得跳过；具有成功响应证据的 `ready|upstream-empty|manual` 继续保留。

## Risks / Trade-offs

- [过渡期幂等依赖单一 31901 Agent] → 部署核验单监听；多实例前用 PostgreSQL 唯一约束替换进程内临界区。
- [job URL 被复制到不同工作区] → 服务端授权并由客户端校验 project/run/marketplace/ASIN 作用域，不匹配时不自动 POST。
- [基础 build 与后台图片写文件交叠] → 图片 enrichment 只在基础 build 完成并提交发布请求后启动；图片结果不触发隐式 Web 启动。
- [supervisor 重载失败导致页面仍是旧构建] → 保留 publication pending 与可重放 request，31900 旧健康实例不先停后起。
- [traffic snapshot 与 legacy 数据形状不同] → Agent 端完成单一 normalized contract，页面不直接读取数据库 schema。
- [第三方合法空数据与连接器异常难区分] → 只有成功响应且通过 schema 校验的空结果才能标记 upstream-empty，异常与超时使用独立 reason。
- [live worktree 运行 WIP 被误提交] → 所有实现使用独立代码 worktree、显式路径暂存、逐 Slice commit；部署前只读核对 live diff 与目标提交。
- [真实 provider 传输故障被误报为空数据] → 以结构化命令结果覆盖退出码推断，只有成功且 schema-valid 的空响应可归为 upstream-empty。
- [备用方案造成重复收费或假成功] → 不自动重试、不切 fake/cache、不清空成功阶段；仅管理员显式续跑失败阶段，且复用单 Worker 去重门。
- [浏览器泄露或重复提交凭证] → 仅最高管理员、同源认证、受限请求体与现有加密/审计边界；响应不含 secret，提交按钮同步防重。
- [环境变量与托管凭证冲突] → active 托管记录优先；环境变量只在没有托管记录时兜底，界面显示来源但不显示值。
- [历史重分类误伤合法空数据] → 必须先预览且只处理诊断版本前、无成功响应或 schema-valid 空结果证据的终态模块；重分类为 pending 而非臆测故障，版本不匹配拒绝应用。
- [凭证探测触发真实费用或后台任务] → 探测使用每连接器既有最小健康合同和单次请求，不创建 sync job、不写业务快照、不自动重试。

## Migration Plan

1. 用户审核本 OpenSpec；未确认前不创建代码实现窗口。
2. 在独立代码 worktree 执行 Slice 1，完成 resume/dedupe 合同、单元测试与浏览器级刷新测试；不部署。
3. 执行并审查 Slice 2，使用 fake connector 覆盖单 ASIN失败、空结果、单图超时及 traffic 先于图片；不运行全量真实采集。
4. 执行并审查 Slice 3，确认 runner/测试中不再引用旧 restart 路径；在隔离端口验证 supervisor 只替换 Web child。
5. 部署前只读确认 31900/31901/58258 健康且 active sync job=0，完成 fresh build；在业务空档用正式 launcher 受控更新，验证无 3000 监听或黑框。
6. 执行并审查 Slice 4，在测试数据库验证 traffic snapshot 幂等写入、越权不可见和动态读取；再用一次受控真实 smoke 证明新 traffic 数据无需 build 即可显示。
7. 若任一 Slice 验收失败，停止后续部署并回退该 Slice；不得 reset/clean/stash/rebase/amend，不删除运行数据或 PostgreSQL 快照。
8. 真实 provider smoke 暴露传输失败时，先完成安全诊断与降级续跑 Slice；假 provider 集成和 build 通过后受控部署，只对原三个 ASIN 显式续跑一次。失败则停止新请求并保留全部证据。
9. 续跑仍失败时停止所有真实请求；先离线交付混合凭证管理、逐连接器探测、启动前门禁和遗留状态预览/重分类。定向测试、假 provider 集成、一次 build 与限定复审通过后再受控部署；没有用户新的明确批准不得进行下一次真实 smoke。
