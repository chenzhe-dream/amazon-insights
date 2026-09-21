# 本地实施与验收记录

> 本文件记录首个总览切片。用户随后追加“完成后统一审核”，后三模块与原版结果区的补齐记录见 `completion-verification.md`。以下“前端未改”“无迁移”和当时未修复的身份断言仅描述首个切片，不能用作当前交付状态。

日期：2026-09-16。状态：本期本地实施完成，未发布、未重启正式服务。

## 范围

按已审核流程接通市场总览 v5 入口、独立综合模型身份和无模型恢复路径；整理四模块规则与缺口。未改原版前端，未新增数据库迁移，未覆盖历史任务；其他三模块的未确认字段、公式、阈值仍按清单分期确认。

正式执行由服务端代码编排来源采集、确定性计算、受控模型任务、证据校验及报告保存。语义任务仍需要后端模型配置，不依赖 Cursor 编辑器或个人配置。规则清单是审核文档，本期没有新增运营规则页面。

## 修改与对应验证

| 修改 | 验证 |
|---|---|
| 新任务冻结 v5、完整数字目录、独立 synthesis 身份 | 新入口测试；真实 HTTP POST 创建后驱动完整综合链路 |
| 按组织与幂等命令先查原任务，验证原研究和公开参数；并发冲突重新读取胜出任务 | v3/v5 重放、身份变化、不同配置并发、参数冲突、组织隔离、停用用户 |
| 无模型服务接收完整流程的数字和报告步骤 | v4/v5 来源采集后均保存数字与明确缺失报告 |
| 仅对 overview v4/v5 的无法执行语义步骤显式失败 | 排队 preparation/model-batch 后丢失配置，步骤全部收尾；不调用模型；保留历史 |
| 已保存模型输出的最终报告使用纯报告处理器 | 配置消失后仍能保存综合报告，不增加模型/来源调用 |
| 证据范围、失败定向重试和报告历史 | 非法综合输出和伪造报告被拒绝；重试不重跑成功兄弟步骤；历史只读 |

## 测试证据

以下路径相对本工作树；所有数据库测试使用独立临时 PostgreSQL，连接器与模型使用合成实现，没有消耗正式供应商或模型额度。

- 边界回归：25/25，通过。日志 `.superpowers/sdd/market-backend-final-boundary.log`。覆盖入口、综合证据/身份/绑定/读取、前端依赖边界和服务关闭。
- 旧流程与 HTTP/跨站回归：16/16，通过。日志 `.superpowers/sdd/market-backend-legacy-regression.log`。
- 无模型恢复：5/5（含父测试），通过。命令 `node --import tsx --conditions=react-server --test tests/agent/market-overview-source-only.test.ts`；日志 `.superpowers/sdd/market-backend-source-recovery-final.log`。
- 完整 v5 综合测试：通过，33 个窗口、77 个事实、82 个缺失项。测试 `tests/agent/market-overview-synthesis-flow.test.ts`；初次 HTTP 入口版本日志 `.superpowers/sdd/market-backend-synthesis-green.log`。加入最终报告无模型恢复后的该测试也通过，记录于 `.superpowers/sdd/market-backend-restart-green.log` 的对应成功条目；该组合日志中的另一个恢复测试当时仍因等待不足失败，其最终结果以上一条独立日志为准，不能把这个组合日志整体算作全绿。
- 无模型消费者作用域与运行时测试：14/14，通过。`tests/agent/market-overview-unavailable-model.test.ts`、`tests/agent/market-model-runtime.test.ts`；最终日志 `.superpowers/sdd/market-backend-unavailable-final.log`。
- 类型检查：`npm run typecheck` 通过，日志 `.superpowers/sdd/market-backend-final-typecheck.log`。
- 本轮修改的服务、存储、worker 及五个测试文件定向 ESLint 通过；`git diff --check` 通过。
- 前端 251 个文件前后 SHA256 对照：0 变化。记录 `.superpowers/sdd/market-backend-frontend-verification.json`。
- OpenSpec 严格校验通过。

## 审查与边界

独立审查提出的两项恢复缺陷已处理：最终综合报告原先路由到普通报告处理器；配置消失时排队的语义准备/模型步骤无消费者。已分别加入行为回归和受范围约束的收尾消费者，保留租约、提交 fencing 与既有审计保护。

最终独立关闭审查已读取恢复 5/5 与消费者/生命周期 14/14 的日志，确认两项 P2 均关闭，无剩余阻断。本轮新增作用域测试验证旧审计记录未变；同一 claim 已有审计时的保护另有既存运行时回归和静态复核，不夸大新增测试的覆盖范围。

恢复测试早期按固定 15 秒等待，实际数据库结算和报告读取使断言早于收尾；改为整个恢复过程最多 60 秒、250ms 查询一次。保留终态、报告内容、外呼计数和历史不变断言，最终四场景约 8/6/11/13 秒完成。

未宣称全仓测试通过。当前共享工作树还有此前跨站 schema 变化引起的固定身份哈希断言过期：`market-model-runtime-identity.test.ts`、`market-shape-synthesis-task.test.ts`，本期未改这两个文件。总览身份测试已改为检验实际隔离关系（综合身份变化不得污染 legacy/shape 身份），没有盲目替换固定哈希。

本地合成链路通过不等于真实供应商字段完备、语义质量验收或正式发布。下一步按 `docs/market-research/backend-rule-inventory.md` 核对真实输入与三模块规则缺口；发布前仍需使用现有正式任务空闲检查与发布流程。
