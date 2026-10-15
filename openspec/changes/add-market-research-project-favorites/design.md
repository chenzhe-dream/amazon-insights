## Context
用户在 style-v2.html 打开状态下确认方案。正式基线 253366e8，候选独立 worktree。现有 market_favorites 是单模块收藏，保留兼容入口。

## Goals / Non-Goals
**Goals:** V2 视觉、项目粒度统计、真实持久化、报告安全恢复。
**Non-Goals:** 不改四模块分析业务，不重新采集历史数据，不把示例数据写入正式库。

## Decisions
1. 新增项目收藏表和分组表，复用现有登录认证、市场调研权限和 PostgreSQL query context，避免改变旧单模块收藏语义。
2. 项目保存每模块独立 scope 与 runId。服务端验证 run 属于当前组织或已通过收藏共享，并核对模块，从任务记录取真实 scope 和状态；恢复不携带 linkedApply 等触发采集字段。
3. 全体已登录用户同报告集合/条件产生固定指纹，重复收藏返回既有记录；元数据通过带版本 PATCH 修改，仅作者或作者所在组织的管理员/系统所有者可操作。
4. 收藏保存任务身份，列表显示任务当前报告状态；不宣称冻结报告修订版本。报告生成中显示分析中，失败或部分报告显示待补充。
5. 全组织统计独立于分页；筛选结果分页与 CSV 同一口径。分组可创建，默认未分组。元数据仅编辑，不删报告。
6. 新入口与四模块类型分开，避免 favorites 被误当分析模块。原单模块收藏保留，新增统一收藏当前调研入口。

## Risks / Trade-offs
- 页面 URL 中旧任务与当前输入可能不同 → 服务端用任务实际范围保存并在详情逐模块显示。
- 多人编辑覆盖 → revision 冲突返回 409 并保留输入。
- 旧单模块收藏无法可靠合并 → 保留原入口，同时导入为仅保存条件的收藏，不推断虚假四模块项目。

## Historical backfill
用户已要求填充历史数据。按 market_linked_batches 中明确的 runId 关系汇总联动项目，其余任务逐条保留版本，不按同类目同月份猜测关联。使用任务实际 scope、原创建人和创建时间。旧收藏无任务身份时仅导入条件。脚本默认 dry-run、限定候选库、先保存审计快照，再事务插入；固定 ID 和上下文指纹保证重跑不重复、不覆盖用户编辑。不调用供应商、不改原任务和报告。

## Migration Plan
新增 0066 表与索引，先候选数据库验证重复迁移、持久化、跨组织可见、读写权限。32900 构建/浏览器验收后才能正式发布；回滚代码时新表保留数据。

## Confirmed visibility adjustment
用户明确要求取消组织之间的收藏隔离。所有具有市场调研权限的登录用户可看全部调研收藏、分组及已收藏任务的报告；仅已绑定的任务及其 study 获得跨组织 GET 只读授权。未收藏任务仍受原组织规则保护。编辑仍限作者及原组织管理员/所有者，写接口不使用共享读授权。

## Approved category hierarchy, 2026-10-14
Replace the flat saved-project landing list with leaf category -> four modules -> historical report references, following category-favorites-prototype.html. This is a presentation aggregation, not a mutation or inferred linked batch. Preserve every existing favorite and report. Full category path and leaf ID share a category entry; different sites are labeled and filterable. All four module cards remain visible even when empty. History rows retain authoritative site, full path, period, run ID, and original saved analysis parameters. Show a direct preview link without collection triggers, plus metadata details/editing.

Add authenticated GET /project-favorites/catalog and /project-favorites/history. PostgreSQL expands only four module bindings, derives scalar task/report status, aggregates category and module counts, and pages history in SQL. Never send report output_json bodies to Node for listing. Deduplicate repeated references to the same run for display only; retain distinct runs as historical versions. Conditions without a run are counted separately. Four modules count as complete only if ready reports share a category, site, date range and overview-period mode; this does not assert they ran as a linked batch. Stats report categories, report references, aligned complete categories and sites.

Frontend loads category summaries first, then requests only selected category/module history. Cancel stale requests; use a bounded timeout and an explicit retry; never display another category's history under the new heading. Refresh within the same scope can preserve prior rows while showing a refresh indicator. Browser back should restore category/module selection via URL state. Existing group selection, ownership filter, export and author/admin metadata editing remain available.

Implement contracts and isolated SQL/service tests first, then interface and regression tests. Use candidate worktree and 32900 only. No MCP/translation calls, data deletion, migration, 31900 release or unrelated source changes. Benchmark on read-only candidate data; browser acceptance remains separate from successful tests/builds.
