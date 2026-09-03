## 0. 实施隔离与基线

- [x] 0.1 用户明确确认本 OpenSpec 后，使用 `using-git-worktrees` 在独立代码 worktree 创建实现分支；记录基线 HEAD，并确认不在 live worktree 写业务代码。
- [x] 0.2 只读核验 live 31900/31901/58258 各有单一健康监听、`data/sync-jobs` 中 active job=0，并保存不含环境值、凭据或数据库 URL 的计数摘要。
- [x] 0.3 在实现 worktree 确认禁止项：不 push，不使用 reset/checkout/clean/stash/rebase/amend，不运行 `git add .`，不改动或提交 live 的采集生成 WIP、运行数据库及已有 migrations 0001–0010。

## 1. Slice 1 — Job identity、resume 与 dedupe

- [x] 1.1 先扩展 `tests/agent/local-data-bridge.test.ts` 和新增 `tests/agent/sync-job-dedupe.test.ts`，覆盖认证 organization scope、projectId/runId、ASIN 排序规范化、并发相同 POST 返回同一 jobId/`reused: true`、终态后显式重启生成新 job；运行 `npx tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts tests/agent/sync-job-dedupe.test.ts` 并确认 RED。
- [x] 1.2 更新 `shared/agent-contracts.ts`、`server/routes/local-data.ts`、`server/app.ts`、`app/lib/sync-server.ts` 和 `scripts/lib/sync-job-store.mjs`：organizationId 只取认证 principal，校验 project/run 关系，持久化 canonical scope/fingerprint，并在单一 31901 内按 fingerprint 串行执行复用或创建及 Worker 启动。
- [x] 1.3 扩展 `tests/agent/asin-sync-session.test.ts`，覆盖 `syncJob` URL 参数解析/写入/清除、有效 job 只 GET、作用域不匹配不 POST、刷新与等价 rerender 不重复启动；运行该测试并确认 RED。
- [x] 1.4 更新 `app/lib/asin-sync-session.ts`、`app/asin-sync-funnel.tsx`、`app/page.tsx` 和需要的浏览器 client types：URL 作为恢复指针，sessionStorage 仅作辅助；保存 `/v1/local-voc` 返回的 projectId/runId 并传入同步请求，恢复时校验 marketplace/ASIN/project/run 后继续轮询。
- [x] 1.5 运行 `npx tsx --conditions=react-server --test tests/agent/asin-sync-session.test.ts tests/agent/local-data-bridge.test.ts tests/agent/sync-job-dedupe.test.ts tests/agent/contracts.test.ts` 和 `npm run build`；确认刷新路径没有第二次 POST，并以显式文件列表提交 Slice 1。
- [x] 1.6 由独立审核窗口检查 Slice 1 diff、并发测试与 URL 恢复证据；Critical/Important 必须为 0 后才进入 Slice 2。

## 2. Slice 2 — Pipeline 排序、逐 ASIN 状态与图片隔离

- [x] 2.1 先扩展 `tests/scripts/sync-job-progress.test.mjs`、`tests/scripts/asin-sync-job-postconditions.test.mjs` 并新增 `tests/scripts/sync-pipeline-ordering.test.mjs`，覆盖六种逐 ASIN 状态、partial 聚合、`completed-with-gaps`、Alexa manual、traffic 在 image_remarks 之前终态；运行 `node --test tests/scripts/sync-job-progress.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs` 并确认 RED。
- [x] 2.2 更新 `scripts/lib/sync-job-store.mjs`、`scripts/lib/asin-data-status.mjs`、`shared/agent-contracts.ts` 与 `app/lib/sync-server.ts`，把自由字符串 progress 收紧为 `{status, reason, updatedAt}`，实现 stage 聚合与 `queued → running → base-ready → enriching → completed|completed-with-gaps|failed` 生命周期，并确保新增 detail 使用现有 redaction。
- [x] 2.3 重构 `scripts/run-asin-sync-job.mjs` 的基础 cohort 为 catalog → keywords → reviews → sales_trend → child_sales → price_strategy → fba → listing → category → traffic；对每个 ASIN 独立记录成功、合法空、超时和连接器失败，局部失败后继续后续独立阶段，Alexa 直接标记 manual 且不再自动调用 Playwright。
- [x] 2.4 先新增 `tests/scripts/image-remarks-concurrency.test.mjs`，用 fake image worker 证明最大并发 2、每图 90 秒超时边界、单图失败不停止队列且不改变 traffic/base-ready；运行测试并确认 RED。
- [x] 2.5 更新 `scripts/build-listing-image-remarks.mjs` 及最小辅助模块，实现固定上限 2 的队列和单图独立 90 秒取消；将结果按图片归并为所属 ASIN 的 ready/upstream-empty/timeout/connector-failed，不增加自动重试。
- [x] 2.6 更新 `app/asin-sync-funnel.tsx` 的逐 ASIN/逐模块展示与 job 汇总文案，明确 base-ready/enriching、partial 和 manual，不把局部缺口显示为完整成功或全局失败；补充相应渲染/合同测试。
- [x] 2.7 运行 `node --test tests/scripts/sync-job-progress.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs`、`npx tsx --conditions=react-server --test tests/agent/asin-sync-readiness.test.ts tests/agent/contracts.test.ts` 与 `npm run build`；以 fake connector 证明 traffic 不等待图片后，显式提交 Slice 2。
- [x] 2.8 由独立审核窗口检查 Slice 2 的失败分类、后置条件、redaction 和进程终态；Critical/Important 必须为 0 后才进入 Slice 3。

## 3. Slice 3 — 删除旧 3000 路径并受控刷新 31900

- [x] 3.1 先改写 `tests/scripts/sync-runtime-policy.test.mjs`，断言 runner 不再包含 `restartTeamServer`、`start-team-server.ps1` 或任意 Web spawn；保留 build 行为但要求只写 reload request，并运行测试确认 RED。
- [x] 3.2 新增 `scripts/lib/web-reload-request.mjs` 与 `tests/scripts/web-reload-request.test.mjs`，实现忽略提交的 runtime spool、原子写入、jobId/build 时间/目标配置校验、幂等消费和已处理归档；payload 与测试输出不得包含命令、环境值或秘密。
- [x] 3.3 更新 `scripts/run-asin-sync-job.mjs`：基础 cohort 后执行 fresh build、标记 base-ready 并写 reload request，再进入 image enrichment；彻底删除旧 PowerShell/team-server restart 调用，supervisor 缺席时只记录 publication pending。
- [x] 3.4 先扩展 `tests/scripts/start-agent-stack.test.mjs`，证明 supervisor 消费同一 request 只替换 Web child、保持 Agent child、等待目标 Web health、重复 request 不重复重载、失败时保留旧健康 Web；运行测试确认 RED。
- [x] 3.5 更新 `scripts/start-agent-stack.mjs` 以监看 reload spool 并独占 Web child replacement；所有 Windows 子进程保持 hidden，目标端口只取当前 launcher 配置，不硬编码或回退 3000。
- [x] 3.6 运行 `node --test tests/scripts/sync-runtime-policy.test.mjs tests/scripts/start-agent-stack.test.mjs tests/scripts/web-reload-request.test.mjs`、`rg -n "restartTeamServer|start-team-server.ps1" scripts/run-asin-sync-job.mjs tests/scripts` 和 `npm run build`；在隔离端口 smoke 中确认只出现配置的 Web/Agent 监听后，显式提交 Slice 3。
- [x] 3.7 由独立审核窗口检查旧 3000 启动链已不可达、reload 失败不先停旧 Web、31901 不被替换；Critical/Important 必须为 0 后才进入 Slice 4。

## 4. Slice 4 — PostgreSQL traffic 动态读取 tracer

- [x] 4.1 先更新 `tests/agent/contracts.test.ts` 并新增 `tests/agent/traffic-snapshot-read-route.test.ts`，覆盖同组织读取、其他组织统一不可见、尚无 snapshot 返回明确 pending/404、normalized payload 不暴露数据库字段；运行 `npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/traffic-snapshot-read-route.test.ts` 并确认 RED。
- [x] 4.2 复用 `server/services/sif-traffic-snapshot-task.ts`、`server/db/traffic-data-snapshot-repository.ts` 和现有 PostgreSQL migration 0007/store，为有授权 projectId/runId 的 sync traffic 阶段增加 adapter：存在同 run snapshot 时复用，不存在时采集并幂等写入；不得新增或改写 migrations 0001–0010。
- [x] 4.3 在 Agent Service 增加受 principal organization 保护的 run-scoped traffic snapshot 读取 route/service，并在 `shared/agent-contracts.ts` 定义稳定 normalized response；补充 `tests/agent/postgres-traffic-data-snapshot-repository.test.ts`、route/service tests 的幂等和越权覆盖。
- [x] 4.4 先新增 `tests/agent/traffic-snapshot-browser.test.ts`，证明当前 run 的 dynamic snapshot 优先、404 时才使用标注 legacy fallback、PG 新快照到达后无需 reload 即替换 fallback；运行 `npx tsx --conditions=react-server --test tests/agent/traffic-snapshot-browser.test.ts` 并确认 RED。
- [x] 4.5 新增最小 traffic browser client/state 容器，调整 `app/page.tsx`、`app/traffic-fetch-status.tsx`、`app/traffic-analysis-conclusion.ts` 及 `app/sif-listing-traffic-data.ts` 的数据注入边界，让 traffic 视图消费 normalized dynamic payload，并保留其他模块的构建期读取不变。
- [x] 4.6 运行 `npx tsx --conditions=react-server --test tests/agent/postgres-traffic-data-snapshot-repository.test.ts tests/agent/sif-traffic-snapshot-task.test.ts tests/agent/traffic-snapshot-read-route.test.ts tests/agent/traffic-snapshot-browser.test.ts tests/agent/contracts.test.ts`、`npm run test:agent` 和 `npm run build`；在测试 PostgreSQL 中证明新 snapshot 可在已打开页面动态显示且不产生 build/reload request，然后显式提交 Slice 4。
- [x] 4.7 由独立审核窗口检查组织隔离、run/project 归属、snapshot 幂等、legacy 标注和无秘密输出；Critical/Important 必须为 0 后才允许部署裁定。

## 5. 部署裁定与真实验收

- [ ] 5.1 主审核窗口汇总四个 Slice 的提交、测试和独立审查，确认 diff 只包含获批范围；不 push，并保留 live worktree 全部既有 WIP。
- [ ] 5.2 在业务空档前只读确认 live HEAD/目标提交关系、31900/31901/58258 健康、3000 无监听、active sync job=0；任一条件不满足即停止部署且不改服务。
- [ ] 5.3 在独立实现 worktree完成最终 `npm run build`，再通过正式 launcher/supervisor 的受控流程更新当前 31900/31901；不得调用旧脚本，不停止 58258，不打印 env、provider body 或数据库 URL。
- [ ] 5.4 使用一个现有低风险工作区做单次真实 smoke：刷新后 URL 保留同一 jobId 且 POST 数不增加；相同 ASIN 并发请求复用 job；traffic 在图片前可用；单 ASIN 缺口显示明确状态；PG traffic 更新无需 build 可见；全程无 3000 监听或黑框。
- [ ] 5.5 smoke 成功后再次确认三个正式端口健康、active stage=0，并向用户报告部署版本与证据；失败时停止新请求、保留运行数据，按最后一个 Slice 的非破坏回退路径恢复，绝不恢复旧 3000 启动链。

## 6. Slice 5 — 真实 provider 诊断、降级与阶段续跑

- [x] 6.1 先新增无真实 provider 的 runner 集成测试：使用本地假 MCP/provider 与临时数据目录完整 spawn detached runner，证明全新 ASIN 的请求、physical attempt、持久化和 readiness 均为 `ready`；再注入 DNS/TLS/治理拒绝/HTTP/RPC/schema/合法空响应，确认当前实现 RED 且诊断输出不含秘密。
- [x] 6.2 为 worker/runner 增加固定大小、有界且脱敏的子进程诊断捕获，持久化白名单 `{connector, stage, asin, failureKind, causeCode}`；修正生成器与后置条件，使 transport/protocol failure 保持 `connector-failed`/`timeout`，只有成功且 schema-valid 的空响应才是 `upstream-empty`。
- [x] 6.3 在统一 detached Node 网络边界接入正式服务已配置的代理、CA、DNS/dispatcher 与环境继承；禁止在各生成器分别打补丁，禁止记录凭据、请求头、完整地址或数据库 URL。
- [x] 6.4 增加 `provider-degraded` 等价状态与管理面板提示：达到失败门槛后停止该连接器的后续自动请求，保留已成功数据、原 job 和失败阶段；不得自动切 fake/cache、自动重试或把降级结果宣称为本次成功。
- [x] 6.5 增加管理员显式“从失败阶段续跑”合同：仅选择失败/未完成阶段，复用原 scope fingerprint 和单 Worker 临界区，保留成功阶段与旧 attempt；并发续跑仍只产生一个 Worker。
- [x] 6.6 运行本 Slice 定向测试、关键刷新 GET-only/同 scope 单 Worker tracer 和一次 `npm run build`；仅允许一次独立限定复审，Critical 和直接业务阻断必须为 0。
- [x] 6.7 部署前核对候选与共享 worktree，确保 15 项真实运行文件未被暂存或改写；active job/stage=0 后通过正式 supervisor 受控更新 31900/31901，保持 58258，确认 3000 无监听。
- [ ] 6.8 对已保存的三个全新 ASIN 工作区执行恰好一次显式续跑，验证真实数据、故障分类、traffic-before-image、逐 ASIN 状态、刷新 GET-only 与单 Worker；若失败则停止新请求并保留 job、生成数据、PG 快照和脱敏日志，不创建第三个真实 run。

## 7. Slice 6 — 数据源配置、就绪门禁与遗留状态修复

- [x] 7.1 先为现有 connector credential/probe 合同和并发管理面板增加 RED 测试：SellerSprite、SIF、Sorftime 分卡显示 managed/environment/none、最高管理员保存/替换/撤销/探测、普通管理员与 member 拒绝、响应和页面永不含 secret；测试只用加密测试仓库与假 provider。
- [x] 7.2 复用现有组织级 credential repository、cipher、audit 与 connector routes，在并发管理面板加入三个连接器的托管凭证录入和单次探测入口；托管 active 记录优先，环境变量仅显示只读“服务器已配置”，同步双击不得产生重复 PUT/POST。
- [x] 7.3 先新增真实同步就绪门禁 RED 测试，再让页面与 Agent 启动路由按所选阶段计算必需连接器；任一必需连接器未配置、最近探测失败或 provider-degraded 时均不创建 job/Worker，并返回连接器名与安全故障码；fake 模式和纯读取路由保持不变。
- [x] 7.4 新增最高管理员专用遗留修复 preview/apply 合同与 RED 测试：只处理同组织、诊断版本前终态 job 中没有成功响应或 schema-valid 空结果证据的错误 `upstream-empty`，预览返回版本且不写入，apply 仅在版本匹配时原子重分类为 `pending/LEGACY_UNVERIFIED`；不调用 provider、不臆测具体故障、不修改 ready/manual、旧 attempt、文件或 PG 快照。
- [x] 7.5 修正显式续跑 ASIN 选择：job 的 `connector-failed|timeout|pending` 在 resume 时优先于旧构建期占位文件，`ready|upstream-empty|manual` 继续保留；补充旧占位文件存在仍会进入假 provider 的 runner tracer，并证明同 scope 仍只有一个 Worker。
- [x] 7.6 运行 Slice 6 定向 credential/probe/auth/UI、readiness gate、legacy repair、resume runner 与 redaction 测试，以及恰好一次 `npm run build`；核对候选与共享 worktree，显式提交且不包含 15 项真实运行 WIP，不部署、不触碰 31900/31901/58258、不调用真实 provider。
- [x] 7.7 由专业测试窗口做一次限定复审，仅覆盖 Slice 6 规格、新增 diff、秘密不回显、未就绪零 job、修复零 provider 和修复后假 provider 真正执行；Critical 与直接业务阻断必须为 0。Minor 统一 defer，不开启累积 diff hostile review。

## 8. Provider Probe 验收修复

- [x] 8.1 在并发管理面板逐连接器显示探测中的禁用状态、成功或失败结果、安全原因和探测时间；HTTP 200 且 `available=false` 不得显示为通用成功，同步双击仍只产生一个 POST。
- [ ] 8.2 对 8.1 提交运行一次 fresh build，并由独立窗口仅复审 probe 展示、秘密不回显、单 POST 和 15 项 WIP 边界。
- [ ] 8.3 在受保护部署配置中保留既有 `NO_PROXY` 全部条目，仅追加三个固定 provider host，并通过正式 launcher 受控重启 Web/Agent，保持 PostgreSQL 与端口约束。
- [ ] 8.4 三个连接器各显式探测一次且均成功后，执行唯一一次三 ASIN 真实验收；失败即停止，不重复 probe、不创建替代 job，并保留全部脱敏证据。

## 9. 真实验收阻断返修 — 工作区切换与显式分析

- [x] 9.1 用 production page browser harness 覆盖 A→B 工作区加载、旧非终态 `syncJob`、显式 C 分析、刷新和 tab 切换；RED 证据为显式 C 已提交正确 scope，但页面 URL 仍保留旧 job 指针。
- [x] 9.2 移除 overview hydration 的自动同步；显式分析先取得服务端权威 `projectId/runId`，清除旧 `syncJob`，再只提交一次 C scope，并将 URL 替换为新 workspace/new jobId；保留既有 scope mismatch 拒绝合同。
- [x] 9.3 定向 affected suite 通过 28/28，production build 成功；未调用真实 provider、未部署、未 push，15 个生成数据文件与 3 个未跟踪项目 JSON 保持未暂存。

## 10. 真实验收阻断返修 — 手工 VOC 不阻塞基础同步

- [x] 10.1 production page harness 复现 `/v1/local-voc` 对三个新 ASIN 返回 422 后 sync POST=0 的 RED，并覆盖同步双击、旧 run/job 指针、canonical project scope 与 remount GET-only。
- [x] 10.2 首次“开始全自动分析”不调用 local-voc；先且仅创建 canonical analysis workspace，再以该 projectId、`runId: null` 提交一次基础/MCP sync，URL 只采用新 jobId并提示三个 VOC 待手工录入；VOC 页保留显式独立分析入口。
- [x] 10.3 affected suite 通过 28/28，独立 VOC bridge 合同与 production page 定向测试通过，fresh production build 成功；未调用真实 provider、未部署、未 push，15 个生成数据文件与 3 个未跟踪项目 JSON 保持未暂存。

## 11. 真实验收阻断返修 — 既有工作区 PATCH 后启动同步

- [x] 11.1 production page harness 复现既有同市场、同 ASIN 工作区点击分析时 GET 与 PATCH 均成功，但基础 sync 因 Web 合同拒绝显式 `runId: null` 而未转发至 Agent 的 RED。
- [x] 11.2 基础 sync 请求省略不存在的 runId（服务端持久化 scope 仍为 `runId: null`），保留 canonical projectId；既有工作区双击只产生一次通过正式 Web request schema 的 sync POST，并将 URL 更新为新 jobId。
- [x] 11.3 production page affected suite 与 fresh production build 通过；未调用真实 provider、未部署、未 push，15 个生成数据文件与 3 个未跟踪项目 JSON 保持未暂存。

## 12. 真实验收阻断返修 — 本地工作区安全登记到 PG

- [x] 12.1 authenticated HTTP tracer 复现正式 `POST /v1/projects` 已声明合同但 Agent 未注册 handler，local JSON workspace 因未进入 PG 而无法通过 scoped sync 授权的 RED。
- [x] 12.2 复用正式 project create 合同，以可选 UUID 接收 local workspace identity；服务端仅从 session principal 派生 organizationId/createdBy，同 payload 幂等、冲突不覆盖、跨租户统一不可见。页面在基础 sync 前登记同一 identity/name/marketplace/asins，再以该 projectId 只提交一次 sync；刷新保持 GET-only。
- [x] 12.3 production page、project lifecycle/contract 定向测试与 fresh production build 通过；未调用真实 provider、未部署、未 push，15 个生成数据文件与 3 个未跟踪项目 JSON 保持未暂存。

## 13. 真实验收阻断返修 — 同步专用 run 与正式 fake 门禁

- [x] 13.1 先用 production page、Agent HTTP 与 PostgreSQL lifecycle tracer 取得 RED：基础自动分析虽登记 canonical project，但 sync job 的 `runId=null`、traffic snapshot=0；同时证明现有通用 run 创建入口会 enqueue analysis Worker，不能作为修复。
- [x] 13.2 新增非破坏性 PostgreSQL migration 0015，只扩展 `run_stages.status` CHECK 允许 `partial`，并同步 shared schema、repository 类型与 SQLite 测试实现；验证迁移前后既有行与既有状态不变，不改写 migrations 0001–0014。随后在同步启动的 scope fingerprint 临界区内增加同步专用 canonical run：同组织、项目、marketplace 与规范化 ASIN active 提交复用同一 run/job；新 run 只创建唯一 `traffic-analysis` stage，由 sync job 驱动并闭合，不 enqueue 通用 analysis Worker。
- [x] 13.3 更新 production page URL/state：显式分析成功后同时采用服务端返回的 `run` 与 `syncJob`；刷新、remount 与 tab 切换只 GET，同步双击仍恰好一个 job、一个 run、一个 Worker；跨组织、跨 project/run 与旧 job 指针继续拒绝且不自动 POST。
- [x] 13.4 为正式 launcher 增加 fail-closed RED→GREEN：真实部署配置若启用本地 fake provider 模式，必须在派生任何 Web/Agent child 前拒绝且不输出配置值；开发与测试 fixture 保持可显式使用 fake。
- [x] 13.5 运行一次实现侧定向验证：migration 0015 前后数据保持、production page + Agent contracts/auth + PostgreSQL run/snapshot + 同 scope 单 Worker + launcher fake 门禁，并执行一次 fresh build；不得调用真实 provider、不得部署，15 项生成数据与 3 个 project JSON 保持未暂存。
  - 2026-08-23 限定返修：不同 explicit run 的 active scope 统一 409 且不产生 durable work；canonical run 的幂等键绑定本次 sync job，terminal 后可新建 run/job；仅 sync-owned 的唯一 traffic stage 可由 sync Worker 闭合，generic 三 stage run 与 job attempt 保持不变。直接 affected 定向验证 12/12 通过；按复审约束未重复 build，13.6 保持待复审。
- [x] 13.6 由专业测试窗口做一次限定复审，仅覆盖本 Slice diff、租户隔离、无额外 analysis Worker、run/stage 终态、PG traffic 动态读取、刷新 GET-only、单 Worker、正式 fake fail-closed 与 WIP 边界；返修复核 61/61 通过，Critical=0、直接业务阻断=0，18 项业务 WIP 保持在提交外。
- [ ] 13.7 复审通过且 active=0 后，由主窗口裁定受控部署。启动时显式关闭 fake 模式并保留已批准的 LAN auth/origin 安全矩阵；随后只做一次三 ASIN 真实回归。若 Sorftime 再次出现 `MCP_SCHEMA`，停止自动请求并保留脱敏故障证据，不盲目放宽 schema、不自动创建第二个真实任务。
  - 2026-08-23 verified-empty 限定返修：production review harness 的 RED 证明 `product_detail` 已持久化 `status=ready/reviewCount=0` 时仍调用两个 review tools 并触发 `MCP_SCHEMA`；GREEN 仅在 ASIN、marketplace、ready 状态、零评论数与证据日期严格匹配时生成无评论的 ready 记录，零 provider call、零 diagnostic，其他非零/未知/未验证/错 scope 结果继续按 schema/RPC/HTTP fail-closed。affected 19/19、目标 lint 与唯一 production build 通过；未调用真实 provider、未触碰 live，13.7 继续等待独立限定复审与部署裁定。
  - 2026-08-24 SIF traffic snapshot 限定返修：保留 B088LPLNPK 形态的离线 RED 锁定 `ops_get_asin_traffic_trend` 对 `dates + nf + ad` 的严格 schema 不兼容；GREEN 仅增加与既有 `nfScore/adScore` 并列的有界明确形态并归一到同一内部记录。malformed 仍 fail-closed，安全 stage error 仅持久化 asin、operation 与固定 `SIF_TRAFFIC_SCHEMA_INVALID`，失败事务保持 snapshot=0/traffic stage=partial。affected 14/14、目标 lint 与唯一 production build 通过；未调用 provider、未触碰 live，13.7 继续等待独立限定复审与部署裁定。
  - 2026-08-24 原任务生命周期恢复限定返修：RED 证明 admin resume 仅重排 completed job 且覆盖原 actor，sync-owned run/唯一 traffic stage 仍为 terminal，Worker begin 拒绝。GREEN 在同一 serializable PG 事务内，仅对原 organization/job/project/run/created_by、`sync:<org>:<project>` scope、jobId idempotency key、唯一 terminal traffic stage 且 snapshot=0 的持久绑定原地恢复；原 actor、成功模块与生成数据不变，12 路并发仅 1 resumed/1 Worker claim，跨租户、已有 snapshot、非唯一 stage 与注入失败均无半恢复，generic run/job_attempt 不变，handler 闭合同一 run/stage。affected 47/47、目标 lint 与唯一 production build 通过；未调用 provider、未触碰 live，13.7 仍保持未勾选。
  - 2026-08-24 SIF trend 脱敏诊断限定切片：离线对照确认旧 canonical fixture 为 `dates/nfScore/adScore`、B088 保留 fixture 为 `dates/nf/ad`，而保留的 B07 与旧 ASIN 生成文件仅能证明相同的持久 wrapper 形态，不能证明第三种 provider 原始形态；历史 PostgreSQL traffic snapshot 亦始终为 0，因此 parser 保持不变。RED 证明 schema failure 缺少 operation 级 shape 证据；GREEN 仅持久化六个预定义字段的 presence/JSON type/array length 与首个 invalid index/fixed reason，未知字段名、值、body、header 和 secret 均不记录。affected 21/21、目标 lint、唯一 production build 与 strict OpenSpec 验证通过；未调用 provider、未触碰 live，13.7 继续保持未勾选。
  - 2026-08-24 SIF trend 固定 metadata 限定返修：部署后的六字段脱敏诊断证明 B07 canonical `dates/nfScore/adScore` 仅因额外固定 metadata 失败；随后只读保留产物与生成器合同锁定键为 `fetchedAt:string`，20/20 保留 monthly records 均为严格 ISO date，生成器明确以 UTC date-only 写入。RED 证明 strict parser 将该已知键判为 `extra-key`；GREEN 仅在两个既有 strict branch 增加 optional `z.iso.date()`，normalize 丢弃 metadata，invalid date、任意其他 extra key、malformed/hybrid 继续 fail-closed，六字段脱敏 diagnostic 不新增字段名或值。affected 22/22、目标 lint 与唯一 production build 通过；未调用 provider、未触碰 live/browser/deploy/resume，13.7 继续保持未勾选。
  - 2026-08-24 canonical resumability 限定返修：RED 证明 sync-owned run 的唯一 `traffic-analysis` 已为 `partial` 且 snapshot=0 时，file stages 全部 done/skipped/manual 会使 repository 先报无可恢复阶段，terminal hydration 同时清除 `syncJob` 并隐藏管理员续跑入口。GREEN 在同一 serializable 事务内先重验 organization/project/run/actor、sync idempotency scope、jobId key、唯一 traffic stage 与 snapshot absence，仅该安全绑定合成并持久化 `resumeStages=["traffic"]`、原地恢复同 job/run/stage；12 路并发为 1 resumed/11 deduplicated/1 claim，0 INSERT，generic/invalid marker/已有 snapshot/非唯一 stage/回滚继续 fail-closed。正式 GET 公开权威 `resumableStages`；仅非空时保留 URL pointer 并向最高管理员显示唯一按钮，普通 terminal 仍写 tombstone、清 pointer 且不自动启动。affected 79/79、目标 lint 0 error、唯一 production build 与 strict OpenSpec 验证通过；未调用 live/provider/browser/deploy/resume，13.7 继续保持未勾选。
  - 2026-08-24 canonical resumability mapper 限定返修：authenticated GET 的 RED 证明 repository 已返回 `resumableStages=["traffic"]`，但 `SyncJobService` 的 public mapper 丢失该字段并使 route 输出权威空数组。GREEN 仅防御性复制 repository 数组，显式空数组保持权威，未定义值仍由 route 归一为 `[]`；同组织 GET 返回 traffic，跨组织继续统一 404 且不泄露。focused 36/36、目标 lint 0 error 与唯一 production build 通过；未调用 live/provider/browser/deploy/resume，13.7 继续保持未勾选。
  - 2026-08-24 canonical attempt-cycle 限定返修：production PG RED 证明 `leaseGeneration=4` 且持久 `run_stages.attempt_count=0` 的 canonical job 被错误地在 traffic/provider 前判定 `SYNC_JOB_ATTEMPTS_EXHAUSTED`。GREEN 将 lease generation 保持为单调 fencing identity，仅 exact sync-owned canonical traffic 在 begin 时原子递增持久 attempt；authorized explicit admin resume 的同一 serializable 事务才将 attempt reset 为 0，每 cycle 上限 3。真实耗尽在同一事务闭合原 job/run/唯一 traffic stage；旧 exhausted 且 job failed/run queued/stage queued/snapshot=0 的严格 marker 状态可原地恢复，12 路并发仅 1 resumed/11 deduplicated/1 claim，generic lifecycle/job_attempt 不变。focused 50/50、目标 lint 0 error、唯一 production build 通过；未调用 live/provider/browser/deploy/resume，13.7 继续保持未勾选。
  - 2026-08-24 SIF trend 第二阶段脱敏诊断切片：RED 以 absent、严格 date-only、完整 timestamp、错误 JSON type 与两个未知 extra key 证明现有诊断既遗漏 `fetchedAt` 的类型/格式状态，也无法计数 parser allowlist 外字段；PostgreSQL worker seam 同时证明 copy 白名单会丢失新增证据。GREEN 仅把 `fetchedAt` 加入完整诊断 allowlist，记录 `{present,type,dateOnlyValid}` 与不含键名的 `unknownCount`，并在 worker stage error 中原样白名单持久化；未知键名、值、body、header 与 secret 均不记录，`MonthlyTrendSchema` parser 保持不变。focused 20/20、目标 lint 0 error、唯一 production build 与 strict OpenSpec 验证通过；vendor schema 请求、live/provider/browser/deploy/resume 均为 0，13.7 继续保持未勾选。
  - 2026-08-24 SIF trend 官方字段脱敏诊断切片：RED 以 33-key live 等价 fixture 证明旧 parser-known7 的 `unknownCount=29` 不能等同于官方 documented29，并证明现有诊断缺少官方字段、固定 meta、元素类型与核心长度证据。GREEN 仅扩充 shape diagnostic：官方 29 个业务顶层字段逐项记录 presence/JSON type/array length，数组只记录固定元素类型计数与首个非法索引；`_formatted`/`_next_step` 只记录 presence/type；另区分 `parserUnknownCount` 与相对官方字段+meta 的 `outsideOfficialUnknownCount`，未知键名、值、body、header 与 secret 均不持久化。`MonthlyTrendSchema` parser 未改，任意 extra/hybrid/malformed 继续 fail-closed，三 ASIN失败仍保持 snapshot=0/traffic stage=partial。RED 9/11 后 GREEN focused 22/22，目标 lint 0 error 与唯一 production build 通过；未调用 live/provider/browser/deploy/resume，13.7 继续保持未勾选。

## 14. 真实验收收口 — trend 投影与图片重新激活

- [x] 14.1 Trend RED：用 live 等价完整对象证明当前 strict parser 因非领域字段失败；同时锁定核心字段缺失、错型、非法月份、非法 score 和超长数组继续 fail-closed，未知字段名称和值不进入诊断或持久化。
- [x] 14.2 Trend GREEN：在 SIF adapter 边界只投影并严格验证领域消费字段，生成现有 canonical monthly record；禁止 `passthrough`、`any`、raw object 持久化或领域模型扩张。运行定向测试、目标 lint、一次 build 与 strict OpenSpec，显式提交并独立复审。
  - 2026-08-24：RED 定向命令先以完整 36-key 官方对象锁定 strict parser failure，复审追加的 RED 再证明 nested opaque score keys 会改变持久化 hash、缺失核心字段会丢失 absence 语义。GREEN 仅在 SIF 月度 adapter 投影 `dates`、modern `nfScore/adScore` 或 legacy `nf/ad` 与可选 `data_notice/fetchedAt`，并以严格 parsed canonical monthly value 计算月度 request/source/content hash；额外官方/opaque 字段不进入 snapshot、diagnostic 或 hash。最终定向 24/24、changed-file eslint 0 warnings、一次 `npm run build`、strict OpenSpec 与 allowed-path scoped `git diff --check` 均通过。全仓 `npm run lint` 完整运行后因 8,019 个既有、允许范围外的 findings 失败；未调用 provider/live/deploy。
  - 2026-08-24 SIF overview 脱敏诊断限定切片：RED 证明 `ops_get_listing_traffic_overview` 的 schema failure 没有 shape diagnostic，且 PostgreSQL worker seam 无法安全持久化新的 overview union。GREEN 只加入 `kind: "listing-overview"` 的有界 union：固定 root/nested/score-ratio path 的 presence 与 JSON type，及一个固定 first-invalid path/reason；monthly diagnostic 仅增加 `kind: "monthly-trend"`。Worker 在写入 PostgreSQL 前重新白名单复制 union，注入 sentinel 不会持久化。`ListingOverviewSchema`、normalization、adapter、retry、lifecycle 与 provider call 未改。affected 26/26、changed-file eslint 0 error、一次 production build 与 strict OpenSpec 通过；未调用 provider/live/browser/deploy/resume，14.3 继续保持未勾选。
  - 2026-08-24 SIF overview diagnostic runtime-boundary follow-up：RED 证明白名单 copy 仍会原样持久化被篡改的允许字段 scalar。GREEN 将 worker copy 收紧为完整 discriminated union runtime validation：kind、candidate type、所有固定 field presence/type、first-invalid、monthly safe nonnegative integers 与 exact nested keys 均需通过，否则省略 `shapeDiagnostic` 并保留既有安全 stage error。valid monthly 和 overview diagnostics 仍逐字复制；candidateType、nested type/present、first-invalid field/reason、Infinity/negative/unsafe numeric、unknown key/kind 均不会持久化且 Worker 正常结束。affected 27/27、changed-file eslint、一次 production build、strict OpenSpec 与 scoped diff-check 通过；未调用 provider/live/browser/deploy/resume，14.3 继续保持未勾选。
  - 2026-08-24 SIF overview no-ad canonical projection：离线 RED 复现 B088 official-shaped overview 的 `overview.ad` 缺失导致 schema failure。GREEN 保持 canonical schema 的 nested `ad` 必填，仅在精确“全自然”同响应等价条件成立时投影 `{score:0,ratio:0}`：overview/nf plain、nested ad truly absent、root ad own empty plain object、nf score/total finite positive、nf ratio strict `1`、固定 absolute `|total-nf.score|<=1e-8`；root recommend 不参与 paid 判定且继续由既有 schema 验证。ratio<1、差异超阈值、zero total、root ad 非空/缺失/null/array、nested ad explicit undefined/null/array/empty/partial/string/nonfinite/negative 均 fail-closed 且 snapshot=0。overview request/source/content hash 只包含下游 consumed aggregate；recommend 动态 key/name/ratio/opaque extra 与 eligible missing-vs-explicit-zero 等价，消费 score aggregate 或 nf/total 改变必改 hash。affected 30/30、changed-file eslint、一次 production build、strict OpenSpec 与 scoped diff-check 通过；未调用 provider/live/browser/deploy/resume，14.3 继续保持未勾选。
  - 2026-08-24 SIF overview channel-order hash follow-up：RED 证明 canonical evidence 自行按 score/label/ratio 重排了 advertisingChannels，但 downstream stable score-only sort 的同分首项仍随 provider 顺序改变，造成 `maxAdvertisingChannel` 与 overview/source checksum 不一致。GREEN 删除 evidence 的独立排序，保留实际 normalized channel 顺序；同分 Alpha/Beta 逆序时 payload max channel、overview request checksum、source checksum 与 content hash 均改变，recommend 未消费字段 hash-stable 覆盖保持通过。affected 31/31、changed-file eslint、一次 production build、strict OpenSpec 与 scoped diff-check 通过；未调用 provider/live/browser/deploy/resume，14.3 继续保持未勾选。
  - 2026-08-24 SIF trend zero-scalar compatibility follow-up：离线 B0G5N593D6 等价 RED 复现六项 `dates/nfScore/adScore` 的 `adScore[3]` primitive `0` 被 strict schema 以 `type` 拒绝。GREEN 仅在月度 adapter 的同一 score-point helper 中将四个既有数组 `nfScore/adScore/nf/ad` 里的 primitive numeric `0`（含 `-0`，JSON 等价零）投影为 `{score:0}`；`null`、非零数值、string、boolean、空/partial object、NaN 和 Infinity 均不转换并继续在原字段/index 以固定 `type` fail-closed。schema union、max 24、length、`fetchedAt` 与 unknown-root 规则均未改变；解析使用投影 canonical value 计算 request/source/content hash，诊断仍使用原始有界候选。numeric-zero 与 canonical-record-zero 在三种 hash 均相同，null 保持不同，opaque key 不泄漏。snapshot task 19/19、combined affected suite 退出码 0、changed-file eslint、一次 production build、strict OpenSpec 与 scoped diff-check 通过。未调用 provider/live/browser/deploy/resume，14.3 继续保持未勾选。
  - 2026-08-24 Task 14.3b monthly point diagnostic：RED 证明授权的 `-0` 被从原始数组错误地选为 index 0；GREEN 仅令 monthly 诊断以 projected candidate 选择 fields/length/first-invalid，再按相同 score field/index 从 raw candidate 读取受限 point shape。新增 point 是 exact closed union（object 仅 `score.present/type`，或 array/string/number/boolean/non-json），legacy 3-key first-invalid 继续接受；4-key form 需通过 field/index/reason/bounded-array 与 semantic correlation 校验，非法值在 Worker 二次 copy 时整体省略。覆盖四个 score field、primitive/container/object score 类别、NaN/Infinity/negative、非点 legacy 保持、PostgreSQL primitive/object 持久化和 14 类篡改。task snapshot 21/21、targeted PostgreSQL Worker tests、changed-file ESLint、一次 production build、strict OpenSpec 与 scoped diff-check 通过；未调用 provider/live/browser/deploy/resume，14.3 继续保持未勾选。
- [ ] 14.3 Trend 受控部署：active=0、正式配置和 WIP 门禁通过后部署；只对原 job/run/traffic stage 原地续跑一次，验证 snapshot=1、stage succeeded 且三个 ASIN traffic 可见，不创建新 job/run/stage。
- [ ] 14.4 Image RED：复现图片阶段首次看到空图册而不调用 provider、随后同一 job 写入 7/7/6 张可分析 URL，却因既有 `upstream-empty/skipped` 不再入队；并发恢复用例证明旧实现可能遗漏或重复。
- [ ] 14.5 Image GREEN：图册从未就绪变为已就绪时重新计算 pending，并以持久化 job/ASIN 执行权保证恰一次图片分析；完成分析后再发布，ready/terminal ASIN 不重跑。运行定向测试、目标 lint、一次 build 与 strict OpenSpec，显式提交并独立复审。
- [ ] 14.6 Image 受控部署与最终验收：不重新发起任务；在原工作区触发唯一合法恢复，验证图片分析调用大于 0 且每张最多一次，主辅图备注可见，traffic snapshot 保持成功，三个新 ASIN 达到完整验收。

## 15. SellerSprite MCP capability and execution evidence

- [x] 15.1 Capability-only probe evidence: loopback MCP proves `initialize -> notifications/initialized -> tools/list`, zero `tools/call`, no ASIN argument, and safe available persistence. Initialize HTTP 400 and timeout persist only safe unavailable state without secret/session/provider-body disclosure. Focused gate: 16/16 pass, 0 skipped.
- [x] 15.2 Admission evidence: SellerSprite unavailable status yields `admit=0` and `workerLaunch=0`; fresh available capability admits the unchanged catalog requirement. No product execution, provider request, job POST, browser, deploy, or business-data write was performed.
- [x] 15.3 Execution and regression evidence: SellerSprite fixed HTTP mappings are `400 -> upstream-permanent/false`, `401|403 -> authentication/false`, `429 -> rate-limit/true`, and `503 -> upstream-temporary/true`; bounded retry starts a fresh session, has no hidden reconnect/redirect, and keeps errors secret-free. Helper normalization preserves object and array results. The reviewed MCP SDK is `1.30.0`; SIF/Sorftime source diff against `3920709446bded497fe1a722db3e742c746c9b73` is empty. Full affected gate: 60/60 pass, 0 skipped.
- [x] 15.4 Final static gates: changed-file lint passes; exactly one fresh `npm run build` in this Task 5–7 batch passed (only the existing chunk-size/classification warnings); strict OpenSpec validation passed; committed-range diff check passed. The 15 generated application-data WIP files, 4 untracked project JSON files, and modified Task 3 report remain outside commits.
- [ ] 15.5 Controller performs the one limited final review of SDK gate, handshake/session, list-vs-call, timeout/close, exact governor accounting, safe errors, SIF/Sorftime no-change, and WIP boundary. Required verdict: `Critical=0`, direct blockers `=0`, `APPROVED FOR CONTROLLED DEPLOYMENT`.

## 16. 已应用 Web artifact 一次性浏览器收敛

- [x] 16.1 RED：扩展 terminal owner 与 production browser harness，证明当前 applied artifact 不一致时旧实现只显示手动提示；锁定 pending/failed/非法 artifact 零导航、同 artifact 零导航、同 scope/job/artifact 首次恰好一次导航、remount/重复回调不再导航，并且刷新恢复 POST=0、Provider=0、新 job/run/stage=0。复核证据：terminal owner 11/11 通过；production browser pattern 7/7 通过。
- [x] 16.2 GREEN：将 terminal session record 升级为兼容 V1/V2 的 V3，并增加 scope-bound `claimArtifactReload({jobId, artifactId})`；`handleTerminalSyncJob` 必须先记录终态再 claim，claim 成功后保留现有 project/tab/run/syncJob、临时加入 `webArtifact` cache-buster 并 `location.replace` 一次。新文档 artifact 匹配后只用 history API 移除 marker；已 claim 仍不匹配或存储失败时仅显示固定手动刷新提示。复核证据：terminal owner 11/11 通过；production browser pattern 7/7 通过。
- [x] 16.3 运行 owner、publication notice 与 production browser affected tests、changed-file ESLint、strict OpenSpec、scoped diff-check 和恰好一次 fresh production build；显式提交并进行限定独立复审。禁止部署、真实 POST、Provider 调用、服务重启和修改运行数据。门禁记录：owner 11/11、browser 7/7；delta lint 通过（new errors=0），full changed-file lint 仅被既有 `app/page.tsx` 债务阻断（base/HEAD 均为 9 warnings + 10 errors；其余四个变更文件 exit 0、3 warnings）；`openspec validate stabilize-resumable-sync-pipeline --strict` 通过；`git diff --check 5eadae0..HEAD` 及工作树 diff-check 通过；`npm run build` 本任务唯一一次执行并通过。
- [x] 16.4 真实双回调与阻断路径 RED：production browser harness 记录软刷新发生时的 artifact，证明旧实现先在旧 artifact 注入运行时图册、随后才加载新 artifact，形成“新图片 + 旧静态备注”；并锁定已 claim 仍不匹配、sessionStorage 失败、publication 缺失/failed/非法 artifact 均不得软刷新。RED 实际每条都在旧 artifact 产生一次运行时刷新；业务 POST=0，额外自动导航=0。
- [x] 16.5 最小 GREEN 与复核：终态处理仅在当前 artifact 已被持久化验证且确实匹配时返回 `settled`，已启动完整文档导航返回 `navigation-started`，其余非收敛路径返回 `convergence-blocked`；URL funnel 仅对 `settled` 执行运行时软刷新。门禁：affected browser/owner tests 91/91；新增代码 lint 0 error（harness 2 个既有 warning）；`app/page.tsx` 仍为基线 10 errors + 9 warnings；strict OpenSpec、diff-check、review 返修后的 production build 均通过；限定独立复审 Critical/Important/Minor=0/0/0。禁止 Provider、业务 POST、部署或服务重启。
