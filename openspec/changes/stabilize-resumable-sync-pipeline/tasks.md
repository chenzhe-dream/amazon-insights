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
