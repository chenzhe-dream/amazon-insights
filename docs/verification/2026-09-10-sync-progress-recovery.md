# 商品同步进度与有界补采验证

## 接续与范围

- 从干净旧祖先 9690ab5 快进到 e7fe683；未回退已发布的 VOC deadline/ownership 修复。
- 只读实查目标 sync job `40c0dd8f-de0f-4767-976c-456b44f4d854` 已 completed，completed_at `2026-09-10T08:57:43.602Z`。Agent 代码为 97f74e4；Web/Agent 健康。
- 西柚 completed/partial 在同一有效 lease/worker 下不再因45秒未heartbeat误判 interrupted；取消、失效租约、worker替换、run/窗口/子体范围检查保留。
- 子体计数明确限于已发现子体。缺口存在时显示商品发现分母、失败和缺失输入 ASIN；RPC_ERROR 仅表述请求失败，不断言服务宕机。
- Sorftime 变体补充共享90秒预算，单个核心请求20秒、可选请求5秒；child_sales两条命令共享180秒。直接Node子进程额外5秒退出余量，按实际剩余预算启动；只终止自己创建的进程。逐子体流式进度与5秒等待更新进入同步消息。
- 可选超时保留已发现子体、分页已有结果和partial metadata，不因此熔断核心请求。两种Sorftime builder逐父体落盘。缓存命中和其他ASIN同步保留原partial outcomes。可选补充与核心销量阶段结果分开，不将空销量伪装成功。
- 西柚正常采集后仅追加一次最多30秒的失败项补采：RPC_ERROR/TIMEOUT发现失败或未就绪详情；复用ready缓存、不force全组。新关系及时checkpoint，已有可用关系不被pending草稿覆盖；取消直接传播。

## RED/GREEN与审查

新增测试先复现终态误判、覆盖缺失、可选超时导致熔断、分页丢失、跨运行partial丢失、逐父checkpoint遗漏、取消被吞、force取消覆盖旧ready，再实施修复。

- `node --test --test-concurrency=1`：sorftime-variant-budget、sorftime-stream、provider-bounded-diagnostics、sorftime-child-sales-parse、asin-sync-job-postconditions、scoped-sorftime-module-fallback、sync-stage-cohort-recovery、rendered-html：71/71通过。随后安全timeout diagnostic新增断言，Sorftime两文件10/10通过。
- `node --import tsx --test --test-concurrency=1`：xydc-variant-sync、xydc-order-job-progress、xydc-order-sync、xydc-order-progress-ui、xydc-variant-section：63/63通过。最后checkpoint保护修正后，xydc-variant-sync完整35/35通过。
- 服务端progress授权范围测试加 `--conditions=react-server`：9/9通过。
- 真实隔离PG覆盖终态、取消、lease/worker、窗口和sidecar；真实子进程取消测试五场景（parent-death、sigterm、db-cancelled、heartbeat-then-cancel、success）在扩大回归中全部通过。
- 年度订单两项交互修正布局后2/2通过；新进度浏览器轮询、隐藏/切项目和最终刷新测试通过。
- 最后 `npm run build` 成功；改动TS/TSX ESLint、MJS语法检查及diff检查通过。保留既有chunk大小和路由分类提示；未声称全仓tsc或全仓测试干净。

扩大并发回归曾触发Windows进程身份锁检查失败，两套在单独/串行完整复跑均通过，未绕过锁检查。初次服务端测试缺react-server条件已修正。年度preview在干净e7fe683也复现不稳定失败；候选触摸失败不能归咎基线，已将完整数据页面恢复原布局，两项候选复跑通过。RPC错误中文断言随准确文案更新。

独立审查发现并修正：缺少family的商品漏报、旧partial outcome被清除、force重采取消时pending覆盖ready。审查不访问生产/provider、不编辑代码。

## 发布保护材料

- 备份目录 `C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/sync-progress-recovery-20260910-0920`。
- 备份时四类活动状态总数0；PG custom dump 4420540字节，目录检查44个TABLE DATA条目。
- 229个generated、项目、共享缓存、状态、配置和当前不可变数据artifact文件复制后逐一核对散列；另备份current-known-good指针。
- 保留正式15个generated改动及test-results，不重启数据库，不直接SQL改状态，不取消真实任务。
- 发布及一次实际失败项补采的结果在执行后追加；本节不把备份或测试当成已发布。
