# 6.2 真实关键词趋势采集兼容验证（2026-09-17）

## 根因

正式直连保存的 source-4 / source-5 / source-7 响应中，keyword_trend 返回合法月搜索量，同时 recommended_bid_trend 包含 -1.00，2026-07 同一值还重复一次。原 collector 将负竞价判为 invalid，任一 invalid 或 conflicting-month 都使整条响应 malformed-response，因此独立有效的搜索量也被丢弃。

-1 的供应商业务含义未在响应 doc 中说明，本变更不宣称其是官方缺失哨兵。它不能作为非负竞价使用，保留原始来源并以 null/missing 表达不可用，路径写入 issues；币种仍未知。

## 最小修复

- 仅推荐竞价的精确 -1、-1.0… 形式适用此兼容处理；其他负数、畸形日期/标签、科学计数、unsafe 数字、身份冲突继续拒绝。
- 相同月份相同值只去重并标记；同指标同月不同值（包含不可用与有效值并存）一律未知，后续重复不能恢复冲突值。
- 月份缺失、零基线及未完成月份规则不变，合法独立指标保留；完整原始 payload/hash 可追溯。
- 不重写历史报告，不修改评分公式、来源提供商或前端。

## 验证

1. 先加入真实响应回放、冲突隔离测试：旧实现出现 3 个预期失败，unsupported negatives 测试通过，见 `.superpowers/sdd/market-live-20260917/trend-red.log`。
2. collector、真实回放、来源快照重建、比较月份、持久化运行时五组测试 49/49 通过，见 `trend-verification.log`。
3. 补充真实 partial 来源保存后严格证据重建测试后，真实回放文件 7/7 通过，见 `trend-recorded-replay.log`（包含步骤 2 已运行的 6 项，不重复累计）。
4. targeted ESLint 与 OpenSpec strict 验证通过。

| 保存的真实来源 | 关键词 | 2026-08 搜索量 | 同比基线 | 推荐竞价 |
|---|---|---:|---:|---|
| source-4 | gel pend | 260 | 114 | null，供应商负值不可用 |
| source-5 | gel oens | 6553 | 4061 | null，供应商负值不可用 |
| source-7 | gel pena | 404 | 587 | null，供应商负值不可用 |

这部分是对本次真实外呼响应的离线回放，不是另一次外部调用，也不单独构成四模块正式部署验收；原始调用由主任务记录。持久化回归使用隔离数据库。

最终 collector + recorded replay 合计 42/42 通过（trend-final.log）。TypeScript 核查中本子任务文件错误为 0；共享树另有 market-product-month-evidence.test.ts 的类型错误，已交由产品池子任务处理，详见 trend-typecheck-final.log；不把全仓 typecheck 宣称为通过。
