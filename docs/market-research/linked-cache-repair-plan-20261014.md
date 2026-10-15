# 联动历史恢复与错误语义修复计划（2026-10-14）

范围：候选 market-research-favorites-v2，离线验证；不发布 31900，不发真实供应商请求。

1. 在 market-linked-analysis.test.ts 添加普通查询复用基础记录及四模块正在执行任务的回归；显式 forceRefresh 保持新任务语义。用全链路虚拟报告验证已完成报告、部分结果恢复和零新增步骤。
2. market-linked-service.ts 在创建基础任务之前查同范围历史记录，命中后在请求内启动/恢复模块，不等待定时轮询。模块匹配完整业务参数、版本、站点、类目、日期，成功结果优先于失败新任务；所有候选通过已有报告读取器验证。并发按业务范围加事务锁，权限保持现有组织边界。
3. quota-exhausted 从 transport 贯通 connector、来源 collector、步骤存储、公开 schema 和页面；保留 rate-limit/local-admission，禁止额度耗尽自动重试；失败页不要建议修改正确类目。
4. 浏览器回归四模块切换、刷新和主动选择历史版本。若已应用标记丢失导致绑定错误，修复并补用例，保留用户主动选择。
5. 执行定向 PostgreSQL、虚拟全流程、浏览器、类型检查和 diff 检查。记录剩余边界；未验证即不标验收完成。

执行结果：上述五项已完成，候选32900已更新并进行真实Chrome普通查询验收。详见 linked-cache-repair-acceptance-20261014.md；31900未发布。
