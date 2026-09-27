## 1. 单商品历史（本轮）
- [x] 1.1 先写 collector/完整日历周期的失败用例，再实现原版格式解析、身份验证、零值/缺月/重复冲突规则。
- [x] 1.2 新增步骤枚举和 rules-v2；固定 ASIN、不可变来源输入、旧版本规划不变；隔离数据库验证重试/重放/越权。
- [x] 1.3 读取公开历史合同并默认展示月度值、近3/6个月；人工保存前后保留来源区别；浏览器验证。
- [x] 1.4 类型检查、相关回归、构建与验收记录；核对发布基线后发布并做真实来源验收。

## 2. 类目看板（后续批次）
- [x] 2.1 核对 category_report/category_trend 返回字段，明确类目与样本、原值与推算的边界。
- [x] 2.2 类目历史、集中度及其他指标按已有任务架构接入并逐项对账。

## 3. 完整报告（后续批次）
- [x] 3.0 新版 Sorftime 商品池（category_report/product_search），毛利字段与最多300成员；旧任务隔离。
- [x] 3.1 后端来源预览/草稿合同，年份和品牌区域来源到位可见，形态未分类单列。
- [x] 3.2 七区 UI 与原版对照，人工保存仍建立独立修订。
- [x] 3.3 拆分并复现原版本地结论阈值及缺失条件，禁止模型替代规则。
- [x] 3.4 补齐商品销售额历史、毛利及准入来源，逐项确认原版口径，不凭现有售价推算毛利。
- [x] 3.5 恢复原版年份筛选、周期排序、10单位价格带和历史点汇总；验证300商品合同、预算、队列与页面承载。

## 4. 综合验收
- [ ] 4.1 同类目固定池至少三个月真实对账、断点恢复、七区完整可见后交业务验收。

第3节已完成本地与隔离数据库验证，并已发布012e9eca。正式10商品任务38步骤完成，历史来源、图片、毛利与七区已核对，断点重试及版本保存/刷新通过且未重采。第4.1仍未勾选：业务最终验收未完成。300商品完整容量使用模拟上游，不能称为真实300商品采集验收。

## 5. Approved original recovery (2026-09-27)
- [x] 5.0 Read approved plan, isolate formal baseline, reconcile OpenSpec and run baseline rule tests (16 passing).
- [ ] 5.1 Correct structured group identities and shared date handling; introduce versioned known aggregates and dependency-specific conclusions; preserve legacy reports.
- [ ] 5.2 Persist scoped autosaved drafts with conflict protection and resize/reload continuity; separate restore actions and snapshot coverage.
- [ ] 5.3 Restore authorized same-query reuse and explicit refresh; enforce concurrent submission deduplication, polling recovery and collapsed clear progress.
- [ ] 5.4 Restore original shape suggestions/taxonomies, batch clear, independent section filters/sorting and missing monthly-per-link column.
- [ ] 5.5 Run isolated database and browser regressions, real saved-data replay, performance measurement, typecheck/build and independent review; prepare scoped release evidence.
