## Context
参照 docs/plans/2026-09-24-shape-original-parity-audit.md。前两批已发布行为保留为旧任务合同；用户最新确认的新任务使用 Sorftime 商品池及原版规则。旧任务不能因读取新增采集。

## 第三批：用户确认的原版恢复（优先于以下历史批次约束）

- 新 rules-v4 使用 Sorftime category_report 商品池，超过100按原版 product_search 补充并去重，最多300；近30天来源不能伪装成所选自然月。
- 每个冻结 ASIN 分别持久化 SalesVolume 与 SalesAmount，可独立重试，金额注明站点币种。原始响应、来源范围、时间与缺失信息入库；旧 v1/v2/v3 不改变规划。
- 毛利接 category_report.gross_profit_margin；准入是原版平台费用后空间分档，不是全成本净利润或法律合规判断。
- 原版七区、价格带10单位、筛选排序、历史缩略图、原版分区/综合规则复用经核对的原版纯函数。原版近3/6条历史汇总与连续日历区间不同，新版按原版计算但保留实际月份及缺失提示；不伪造零值。
- 数据到位即可看报告，标签/勾选改变更新草稿；保存仅建立修订，不能是查看结果的前置门槛。不得引入模型作为上述规则执行条件。
- 先先行测试接入合同和纯函数，再接持久化与页面，隔离数据库/浏览器回归通过后进行真实对账；发布前核对其他任务和正式基线。

## Goals / Non-Goals
第一批接通 Sorftime product_trend SalesVolume：月份历史独立于研究窗口；数据库持久化逐 ASIN 步骤，完整日历周期求和。后续类目趋势、金额、七区草稿和规则结论独立交付，第一批不宣称已完成。

## Decisions
1. 新增 rules-v2 流程，保留 rules-v1 的原始规划和幂等重放。冻结参考月 ASIN 后，每个商品一个 collect-product-history 步骤，使用现有续租/并发/重试。新任务自动采；旧任务查看仍不采。
2. 与扩大 SellerSprite 研究范围相比，独立 Sorftime 历史保留原版来源且不修改研究范围。禁止用 SellerSprite 当月补 Sorftime 的缺月。独立历史不影响已保存分类版本的统计。
3. 原始响应、组织/研究身份、ASIN、站点、抓取时间、历史月份和 units 原值入库；只接受原版已有的 YYYY-MM=value / YYYY年MM月=value 格式（字符串或数组）。重复月份冲突、空值、负数和非整数不能变为销量。
4. 前端显示已存历史和逐商品等待/失败/缺月；近三/六个月及前两自然年只在全部日历月份有效时求和。真实零保留。供应商标记明确；无历史能力的旧报告保留原投影。
5. 读取从当前成功步骤的冻结输入/来源校验后生成公开合同；不联网、不写人工版本；人工修订后同样允许查看独立历史。

## Risks / Trade-offs
- 每个商品增加一次受控请求 → 固定池最多100、逐商品持久化、只重试失败项。
- 两供应商数字不同 → 单独标注，禁止拼接，既有研究统计不变。
- 上游不给历史/缺月 → 明确空或不完整，不能伪造近三个月。

## Migration Plan
新增0059步骤枚举允许值，向后兼容已有行；局部提交隔离测试、类型检查、构建及浏览器验收后再合入发布工作树。回滚应用提交保留兼容枚举及历史记录，禁止删除来源。正式发布前核对其他窗口与15个生成文件指纹。

## 第二批设计：类目来源看板

使用已批准的原版接口，新增 rules-v3：在冻结商品池后排出 6 个独立 collect-shape-category 步骤（report、SalesCount、AvgPrice、三个 Top3 销售额份额）。不改 rules-v1/v2 规划；旧报告读取不补采。

原始响应按组织/研究/节点保存，单步骤失败可重试。read service 校验当前步骤、来源摘要、冻结输入和请求身份后返回瘦身结果；读取不联网。category_report 是抓取时近30天统计，不能冒充研究结束月；category_trend 留存结束月以前的完整自然月，最多120个月。百分比保留0–100；无显式百分号的报告占比不猜单位。销量整数、价格非负小数；重复月份冲突置未知；缺月不补零。销量×均价仅在同月双源齐全时生成，标为估算。

类目看板使用原布局，显示原版统计与两组历史图。商品池仍是 SellerSprite 冻结样本，不因类目报告的 top100_products 改动。类目与固定样本、近30天与研究月份、销量份额与销售额份额分别说明。后五区展示和最终规则结论继续保持独立任务。

实施顺序：先 collector 测试 → 合同/归一化 → 流程版本/步骤持久化 → 校验读取 → 图表映射 → 隔离数据库故障重试/旧版兼容 → 浏览器/构建 → 发布前基线核对与真实任务。

## Approved fourth batch: original recovery
The 2026-09-27 approved plan supersedes earlier conflicting display assumptions. New calculation versions expose known sums and coverage, label shares within known observations, and keep immutable legacy report calculation versions. Conclusions validate their actual input periods rather than a global four-period gate. Shape and price band are separate identity fields. Date parsing is shared and suspicious source dates retain provenance.
Drafts persist separately from report revisions and are scoped by actor, organization/project, marketplace and canonical category. Autosave and source reads never trigger collection or model calls; optimistic draft versions preserve conflicting edits. Same-query collection reuses an authorized active run or a compatible report within seven days; explicit refresh creates a new collection. Scope and parameter identity include source version, periods and pool size. No cross-capacity source reuse in this batch.
Restore per-section filters, shape suggestions and taxonomy controls, missing columns and sorting. Keep seven existing report sections and original thresholds. Status failures back off without erasing drafts, disclose last update, and keep step diagnostics collapsed. Isolated tests, browser screenshots, typecheck/build and a release baseline audit precede deployment; unrelated unpublished modules remain excluded.
