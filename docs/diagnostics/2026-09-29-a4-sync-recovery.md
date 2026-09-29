# A4竞对：五个 ASIN 同步问题与修复

范围：B0FGJNBNYD、B0DQDD5SY5、B0FN7XXJRM、B0G7ZDXJP4、B0GCF572WW。

代码基线：65d2a154。修复位于独立分支 codex/sync-gap-recovery-20260929，未发布、未改正式项目结果。

## 问题与处理

1. **流量快照保存失败。** 最新任务曾只记录 `SYNC_TRAFFIC_SNAPSHOT_FAILED / infrastructure`。已保存的五个 ASIN 数据可以通过本地采集转换；进一步复现发现，快照使用顺序敏感的 JSON.stringify 计算校验值，PostgreSQL JSONB 调整 listingCollection.records 的 ASIN 键顺序后，读回校验失败。改用规范化 JSON 哈希；兼容仍可通过原校验的历史快照，仍拒绝真实内容篡改。
2. **备用商品底库被视为已补齐。** 首次 SellerSprite 调用有 RESOURCE_GOVERNOR 拦截记录，随后使用 sorftime-fallback。旧判断只看 ASIN 是否存在，后续采集和补抓均可能跳过主数据源。现在区分可展示的备用数据与主数据源补齐状态，SellerSprite 成功后只升级对应备用条目。Sorftime-only 方案及主数据源已完成的条目仍保持原处理方式。
3. **局部类目同步覆盖未请求的关联。** 原实现会在重建同一节点时只留下当前请求的 ASIN。现在保留同站点、未参与本次请求的已知关联，记录各关联原确认日期；已重新请求的 ASIN 不继承其他商品或过期批次的结论。另修复返回错误 ASIN 但有 node_id 时未拒绝的问题。
4. **价格格式错误可能被当作无数据。** 新增价格消费边界验证，区分合法缺失/零价格与格式错误、ASIN 不匹配、趋势格式异常；异常按 ASIN、操作名与 MCP_SCHEMA 透传。不会将缺价填成零。
5. **错误上下文不足。** 快照错误现在区分读取已有快照、取数、转换、构建候选、保存和读回阶段，并保留安全的 ASIN、接口名、原因代码。不会记录凭据、原始响应或数据库连接串。

## 真实数据核验

- 2026-09-29 使用正式连接配置、组织凭据解析与限流器，实际执行五个 ASIN 的概览、结构、月趋势读取，共 15 次，全部成功。候选快照在本地验证，没有写入正式项目报告。
- 五个 ASIN 的已保存原始数据，通过 PostgreSQL 的只读 `SELECT ...::jsonb` 重排后，旧哈希失败、新哈希通过。
- 在独立 PostgreSQL 测试容器验证包含非排序 ASIN 键的 listingCollection 可保存和读回；同时保留组织隔离、事务回滚、内容冲突与篡改检测测试。
- 评论模块现有逻辑已区分空样本与解析失败，13 项评论回归通过。本次仅修复测试夹具漏引入 generated-app-data-path 的问题，没有重写评论分析。

## 尚需区分的数据缺口

- B0FN7XXJRM 的原始价格证据为 price=0，没有可核验的正价；代码修复不会伪造价格。
- B0GCF572WW 当前评论分析没有取得 Customers Say/评论样本，不能据此说亚马逊评论总数为零；历史任务另出现过 MCP_SCHEMA，应按各次任务的诊断区分。
- B0DQDD5SY5、B0FGJNBNYD、B0G7ZDXJP4 的类目关联曾存在于早期批次、最新批次缺失。已修复局部覆盖缺陷，但没有把旧批次证据直接写成最新数据。发布后需要有范围的补采确认。
- 旧失败任务不会因代码改变自动成功，需要发布修复后进行补抓/重跑；本次没有更改历史任务状态。

## 验证范围与限制

专项脚本、快照、修复调度、worker 生命周期及 PostgreSQL 集成回归通过；TypeScript 和改动文件 ESLint 检查通过。

较宽的 sync-job-production-main-resume 套件有 6 项既存失败，在 65d2a154 基线也同样失败：旧 XYDC 调用预期、缺失数据夹具的 ready 预期、child_sales 调度预期、两个 schema tracer 预期、图片任务的其他阶段调用预期。已对照记录于本地 test-results/baseline-main-resume.txt；不把该套件表述为全绿，也不为通过旧测试改变本次无关业务规则。
