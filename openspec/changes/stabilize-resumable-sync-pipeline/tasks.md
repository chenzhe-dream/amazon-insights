## 0. 实施隔离与基线

- [x] 0.1 用户明确确认本 OpenSpec 后，使用 `using-git-worktrees` 在独立代码 worktree 创建实现分支；记录基线 HEAD，并确认不在 live worktree 写业务代码。
- [x] 0.2 只读核验 live 31900/31901/58258 各有单一健康监听、`data/sync-jobs` 中 active job=0，并保存不含环境值、凭据或数据库 URL 的计数摘要。
- [x] 0.3 在实现 worktree 确认禁止项：不 push，不使用 reset/checkout/clean/stash/rebase/amend，不运行 `git add .`，不改动或提交 live 的采集生成 WIP、运行数据库及已有 migrations 0001–0010。

## 1. Slice 1 — Job identity、resume 与 dedupe

- [ ] 1.1 先扩展 `tests/agent/local-data-bridge.test.ts` 和新增 `tests/agent/sync-job-dedupe.test.ts`，覆盖认证 organization scope、projectId/runId、ASIN 排序规范化、并发相同 POST 返回同一 jobId/`reused: true`、终态后显式重启生成新 job；运行 `npx tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts tests/agent/sync-job-dedupe.test.ts` 并确认 RED。
- [ ] 1.2 更新 `shared/agent-contracts.ts`、`server/routes/local-data.ts`、`server/app.ts`、`app/lib/sync-server.ts` 和 `scripts/lib/sync-job-store.mjs`：organizationId 只取认证 principal，校验 project/run 关系，持久化 canonical scope/fingerprint，并在单一 31901 内按 fingerprint 串行执行复用或创建及 Worker 启动。
- [ ] 1.3 扩展 `tests/agent/asin-sync-session.test.ts`，覆盖 `syncJob` URL 参数解析/写入/清除、有效 job 只 GET、作用域不匹配不 POST、刷新与等价 rerender 不重复启动；运行该测试并确认 RED。
- [ ] 1.4 更新 `app/lib/asin-sync-session.ts`、`app/asin-sync-funnel.tsx`、`app/page.tsx` 和需要的浏览器 client types：URL 作为恢复指针，sessionStorage 仅作辅助；保存 `/v1/local-voc` 返回的 projectId/runId 并传入同步请求，恢复时校验 marketplace/ASIN/project/run 后继续轮询。
- [ ] 1.5 运行 `npx tsx --conditions=react-server --test tests/agent/asin-sync-session.test.ts tests/agent/local-data-bridge.test.ts tests/agent/sync-job-dedupe.test.ts tests/agent/contracts.test.ts` 和 `npm run build`；确认刷新路径没有第二次 POST，并以显式文件列表提交 Slice 1。
- [ ] 1.6 由独立审核窗口检查 Slice 1 diff、并发测试与 URL 恢复证据；Critical/Important 必须为 0 后才进入 Slice 2。

## 2. Slice 2 — Pipeline 排序、逐 ASIN 状态与图片隔离

- [ ] 2.1 先扩展 `tests/scripts/sync-job-progress.test.mjs`、`tests/scripts/asin-sync-job-postconditions.test.mjs` 并新增 `tests/scripts/sync-pipeline-ordering.test.mjs`，覆盖六种逐 ASIN 状态、partial 聚合、`completed-with-gaps`、Alexa manual、traffic 在 image_remarks 之前终态；运行 `node --test tests/scripts/sync-job-progress.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs` 并确认 RED。
- [ ] 2.2 更新 `scripts/lib/sync-job-store.mjs`、`scripts/lib/asin-data-status.mjs`、`shared/agent-contracts.ts` 与 `app/lib/sync-server.ts`，把自由字符串 progress 收紧为 `{status, reason, updatedAt}`，实现 stage 聚合与 `queued → running → base-ready → enriching → completed|completed-with-gaps|failed` 生命周期，并确保新增 detail 使用现有 redaction。
- [ ] 2.3 重构 `scripts/run-asin-sync-job.mjs` 的基础 cohort 为 catalog → keywords → reviews → sales_trend → child_sales → price_strategy → fba → listing → category → traffic；对每个 ASIN 独立记录成功、合法空、超时和连接器失败，局部失败后继续后续独立阶段，Alexa 直接标记 manual 且不再自动调用 Playwright。
- [ ] 2.4 先新增 `tests/scripts/image-remarks-concurrency.test.mjs`，用 fake image worker 证明最大并发 2、每图 90 秒超时边界、单图失败不停止队列且不改变 traffic/base-ready；运行测试并确认 RED。
- [ ] 2.5 更新 `scripts/build-listing-image-remarks.mjs` 及最小辅助模块，实现固定上限 2 的队列和单图独立 90 秒取消；将结果按图片归并为所属 ASIN 的 ready/upstream-empty/timeout/connector-failed，不增加自动重试。
- [ ] 2.6 更新 `app/asin-sync-funnel.tsx` 的逐 ASIN/逐模块展示与 job 汇总文案，明确 base-ready/enriching、partial 和 manual，不把局部缺口显示为完整成功或全局失败；补充相应渲染/合同测试。
- [ ] 2.7 运行 `node --test tests/scripts/sync-job-progress.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs`、`npx tsx --conditions=react-server --test tests/agent/asin-sync-readiness.test.ts tests/agent/contracts.test.ts` 与 `npm run build`；以 fake connector 证明 traffic 不等待图片后，显式提交 Slice 2。
- [ ] 2.8 由独立审核窗口检查 Slice 2 的失败分类、后置条件、redaction 和进程终态；Critical/Important 必须为 0 后才进入 Slice 3。

## 3. Slice 3 — 删除旧 3000 路径并受控刷新 31900

- [ ] 3.1 先改写 `tests/scripts/sync-runtime-policy.test.mjs`，断言 runner 不再包含 `restartTeamServer`、`start-team-server.ps1` 或任意 Web spawn；保留 build 行为但要求只写 reload request，并运行测试确认 RED。
- [ ] 3.2 新增 `scripts/lib/web-reload-request.mjs` 与 `tests/scripts/web-reload-request.test.mjs`，实现忽略提交的 runtime spool、原子写入、jobId/build 时间/目标配置校验、幂等消费和已处理归档；payload 与测试输出不得包含命令、环境值或秘密。
- [ ] 3.3 更新 `scripts/run-asin-sync-job.mjs`：基础 cohort 后执行 fresh build、标记 base-ready 并写 reload request，再进入 image enrichment；彻底删除旧 PowerShell/team-server restart 调用，supervisor 缺席时只记录 publication pending。
- [ ] 3.4 先扩展 `tests/scripts/start-agent-stack.test.mjs`，证明 supervisor 消费同一 request 只替换 Web child、保持 Agent child、等待目标 Web health、重复 request 不重复重载、失败时保留旧健康 Web；运行测试确认 RED。
- [ ] 3.5 更新 `scripts/start-agent-stack.mjs` 以监看 reload spool 并独占 Web child replacement；所有 Windows 子进程保持 hidden，目标端口只取当前 launcher 配置，不硬编码或回退 3000。
- [ ] 3.6 运行 `node --test tests/scripts/sync-runtime-policy.test.mjs tests/scripts/start-agent-stack.test.mjs tests/scripts/web-reload-request.test.mjs`、`rg -n "restartTeamServer|start-team-server.ps1" scripts/run-asin-sync-job.mjs tests/scripts` 和 `npm run build`；在隔离端口 smoke 中确认只出现配置的 Web/Agent 监听后，显式提交 Slice 3。
- [ ] 3.7 由独立审核窗口检查旧 3000 启动链已不可达、reload 失败不先停旧 Web、31901 不被替换；Critical/Important 必须为 0 后才进入 Slice 4。

## 4. Slice 4 — PostgreSQL traffic 动态读取 tracer

- [ ] 4.1 先更新 `tests/agent/contracts.test.ts` 并新增 `tests/agent/traffic-snapshot-read-route.test.ts`，覆盖同组织读取、其他组织统一不可见、尚无 snapshot 返回明确 pending/404、normalized payload 不暴露数据库字段；运行 `npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/traffic-snapshot-read-route.test.ts` 并确认 RED。
- [ ] 4.2 复用 `server/services/sif-traffic-snapshot-task.ts`、`server/db/traffic-data-snapshot-repository.ts` 和现有 PostgreSQL migration 0007/store，为有授权 projectId/runId 的 sync traffic 阶段增加 adapter：存在同 run snapshot 时复用，不存在时采集并幂等写入；不得新增或改写 migrations 0001–0010。
- [ ] 4.3 在 Agent Service 增加受 principal organization 保护的 run-scoped traffic snapshot 读取 route/service，并在 `shared/agent-contracts.ts` 定义稳定 normalized response；补充 `tests/agent/postgres-traffic-data-snapshot-repository.test.ts`、route/service tests 的幂等和越权覆盖。
- [ ] 4.4 先新增 `tests/agent/traffic-snapshot-browser.test.ts`，证明当前 run 的 dynamic snapshot 优先、404 时才使用标注 legacy fallback、PG 新快照到达后无需 reload 即替换 fallback；运行 `npx tsx --conditions=react-server --test tests/agent/traffic-snapshot-browser.test.ts` 并确认 RED。
- [ ] 4.5 新增最小 traffic browser client/state 容器，调整 `app/page.tsx`、`app/traffic-fetch-status.tsx`、`app/traffic-analysis-conclusion.ts` 及 `app/sif-listing-traffic-data.ts` 的数据注入边界，让 traffic 视图消费 normalized dynamic payload，并保留其他模块的构建期读取不变。
- [ ] 4.6 运行 `npx tsx --conditions=react-server --test tests/agent/postgres-traffic-data-snapshot-repository.test.ts tests/agent/sif-traffic-snapshot-task.test.ts tests/agent/traffic-snapshot-read-route.test.ts tests/agent/traffic-snapshot-browser.test.ts tests/agent/contracts.test.ts`、`npm run test:agent` 和 `npm run build`；在测试 PostgreSQL 中证明新 snapshot 可在已打开页面动态显示且不产生 build/reload request，然后显式提交 Slice 4。
- [ ] 4.7 由独立审核窗口检查组织隔离、run/project 归属、snapshot 幂等、legacy 标注和无秘密输出；Critical/Important 必须为 0 后才允许部署裁定。

## 5. 部署裁定与真实验收

- [ ] 5.1 主审核窗口汇总四个 Slice 的提交、测试和独立审查，确认 diff 只包含获批范围；不 push，并保留 live worktree 全部既有 WIP。
- [ ] 5.2 在业务空档前只读确认 live HEAD/目标提交关系、31900/31901/58258 健康、3000 无监听、active sync job=0；任一条件不满足即停止部署且不改服务。
- [ ] 5.3 在独立实现 worktree完成最终 `npm run build`，再通过正式 launcher/supervisor 的受控流程更新当前 31900/31901；不得调用旧脚本，不停止 58258，不打印 env、provider body 或数据库 URL。
- [ ] 5.4 使用一个现有低风险工作区做单次真实 smoke：刷新后 URL 保留同一 jobId 且 POST 数不增加；相同 ASIN 并发请求复用 job；traffic 在图片前可用；单 ASIN 缺口显示明确状态；PG traffic 更新无需 build 可见；全程无 3000 监听或黑框。
- [ ] 5.5 smoke 成功后再次确认三个正式端口健康、active stage=0，并向用户报告部署版本与证据；失败时停止新请求、保留运行数据，按最后一个 Slice 的非破坏回退路径恢复，绝不恢复旧 3000 启动链。
