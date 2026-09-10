## Why

当前新品定义页面在手工 VOC 未完成、关键词缺失、后台没有联合报告时，仍通过全局 generated 评论和前端规则生成“最终产品定义”。需要把输入可用性、用户启用兜底的动作、真实任务结果及版本新鲜度分开，恢复结论可信度。

## What Changes

- 服务端按授权项目、站点、所选 ASIN 与来源版本建立输入清单；有效已保存手工 VOC 优先，仅用户明确启用时使用有内容、可追溯的 Sorftime 评论填补缺口。
- 复用 VOC snapshot、持久运行与 product-definition 执行链；读取页面不创建任务，不读取全局 generated 文件充当当前证据。
- 当前页面只渲染匹配范围与输入版本的持久报告；历史报告可查，更新输入后标待更新。
- 独立表达来源模式、执行状态、ASIN/维度覆盖与关键词 ready/empty/failed/missing 状态。缺证据不默认 D，不伪造证据 ID 或输出最终 A 级立项。
- 在现有模块加入紧凑来源条、缺口与明确分析/更新动作，保留 deadline、ownership、幂等及迟到结果防护。

## Capabilities

### New Capabilities

- `voc-keyword-evidence-gating`: 手工优先、显式评论兜底、作用域输入清单、可信持久报告与更新边界。本基线没有 openspec/specs 主规格目录，建立独立 capability，不并入旧稳定化 change。

### Modified Capabilities

无。

## Impact

影响 app/page.tsx、app/product-definition-section.tsx、app/lib/voc-run-browser.ts、VOC 就绪共享 helper、shared/agent-contracts.ts、来源读取/快照、analysis-run-service、VOC/联合 runtime 与输出合同；按需调整 SQLite/PostgreSQL 的运行输入持久字段及测试 fixture。无新增第三方依赖。当前仅在独立工作树准备并验证修复；push、发布、正式服务重启、真实业务 POST、真实 Provider 调用与正式数据修改不在授权范围。
