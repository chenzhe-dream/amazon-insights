---
name: amazon-product-launch-analysis
description: Generate Amazon product launch recommendations from VOC seven-dimension summaries, Sorftime review analysis, Sorftime sales trends, and competitor catalog data. Use when refreshing 立项决策, running cross-dimensional VOC立项 analysis, scoring product opportunities, or analyzing a new set of competitor ASINs for go/no-go decisions.
---

# Amazon Product Launch Analysis（立项决策）

## When to use

- User asks for **立项决策**, **开品建议**, **VOC 七维交叉分析**, or **产品机会评分**
- New competitor ASINs were added and the **立项决策** tab needs refreshed conclusions
- User wants the same structured analysis used in the dashboard, applied to another category

## Prerequisites

1. Competitor ASINs configured in `app/page.tsx` / `app/competitor-data.ts`
2. VOC data synced:
   - Alexa 七问 → `app/rufus-voc-data.ts` (`npm run voc:sync` or project equivalent)
   - Sorftime 评论分析 → `app/sorftime-review-analysis-data.ts` (`npm run review:sync`)
3. Sorftime 月销量 → `app/sorftime-sales-trend-data.ts` (`npm run sales:sync`)
4. Build: `npm run build` and restart team server if deploying

Cache-first policy: sync scripts use local cache unless `FORCE_REFRESH=1` or `--force`.

## Core modules

| File | Role |
|------|------|
| `app/features/voc/voc-development-summary.ts` | Seven-dimension theme aggregation + normalization |
| `app/features/voc/voc-theme-merge.ts` | Semantic theme dedup across dimensions |
| `app/product-launch-analysis.ts` | **Analysis engine** — conclusions, cross-analysis, scoring |
| `app/product-launch-recommendation.tsx` | **UI** for `?tab=launch` |
| `app/product-definition-section.tsx` | **UI** for `?tab=definition` |
| `app/launch-section.tsx` | Shared section/table layout |
| `app/launch-checklist.ts` | **立项前确认清单** — 通用 + 五大品类专项 + VOC 动态项 |
| `app/page.tsx` | Tab nav: 立项决策 · 新产品定义 |

## Analysis workflow

1. Read active products (ASIN, brand, price, sales, subRankCategory)
2. Call `buildVocDevelopmentSummary(products)` — seven dimensions, pct sums to 100% per dimension
3. Call `buildProductLaunchAnalysis(products)` — full launch report
4. Render via `ProductLaunchRecommendationSection` on tab `launch`

Do **not** hardcode category-specific markdown in the UI. All conclusions must flow from `buildProductLaunchAnalysis`.

## Required output sections (page + chat)

When user requests full analysis in chat, mirror the page structure:

### 1. 明确结论（先读这里）

Answer these five questions with **clear sentences**, not raw tables:

- 类目消费者最关注什么
- 竞品最大共同问题
- 最有价值的未满足需求
- 最值得开发的产品方向
- 是否建议立项

页面另输出 Skill `amazon-voc-insight` 七段：执行摘要（四选一）→ VOC 洞察汇总表 → 差评问题优先级表 → 未满足需求机会表 → 交叉分析 → 机会评分/百分制排序 → 产品方向摘要 → 最终开品九问。
### 2. 七维数据锚点

Top themes per dimension with normalized percentages from `buildVocDevelopmentSummary`.

### 3. 交叉分析（六组，必须做）

| Cross | Purpose |
|-------|---------|
| 顾客关注点 × 差评点 | 关注最高但竞品表现最差 |
| 未满足需求 × 使用场景 | 哪些场景缺合适方案 |
| 使用人群 × 差评点 | 人群在尺寸/安全/操作上的特殊痛点 |
| 购买动机 × 好评点 | 真正推动下单与满意的功能 |
| 评论机会 × Sorftime 市场数据 | 销量、价格带、市场容量 |
| 评论机会 × 供应链能力 | 落地可行性与合规/成本风险 |

Use theme labels from summaries; match related concepts via `voc-theme-merge.ts` patterns.

### 4. 产品机会评分

Score each opportunity 1–5 on:

- 需求频次、痛点强度、市场空间、竞品缺口、差异化程度、实现难度、成本影响、溢价能力、合规风险

**Priority formula** (in code):

```
优先级 = 需求×20% + 痛点×20% + 市场×15% + 缺口×15% + 差异×15% + 溢价×10% + 实现可行性×5%
```

其中 `实现可行性` 为 1–5（5 = 易落地），与 `实现难度` 反向。

Default opportunity templates (adjust relevance from VOC themes):

- A. 耐用结构 + 官方备件包 (P0)
- B. 低龄友好 Lean-to-steer (P0)
- C. 长寿命/可换 LED 模组 (P2)
- D. 低幼 Deck 高度优化 (P1)

### 5. 推荐产品定义

- Must-have (P0)
- Nice-to-have (P1)
- Avoid
- 目标价位（从竞品价格带 +$5–15 推算）

### 6. 新产品定义建议

至少 **3 个**产品开发方向，每个方向包含 16 项字段（见 `ProductDirectionProposal` / `productDirectionFieldLabels`）：

- 产品定位、核心目标人群、核心使用场景、要解决的主要痛点
- 必须保留的基础功能、建议增加的差异化功能、不建议增加的伪需求或高成本功能
- 建议材质/结构/尺寸或配置、建议配件组合、建议价格带、核心卖点
- 与现有竞品的差异、潜在质量风险、潜在合规与专利风险
- 开发难度、立项优先级

生成逻辑：`buildProductDirectionProposals()` — 默认方向 A/B/C，VOC 信号强时追加方向 D。

### 7. 最终立项建议

Verdict from engine:

- `conditional` → **建议立项：有条件通过** + checklist
- `hold` → 数据不足或优先级偏低
- Reasons must cite VOC + market evidence

## Verdict rules (engine)

In `buildProductLaunchAnalysis`:

- No VOC data → `hold`
- Top opportunity priority ≥ 4.5 and sample monthly sales ≥ 5000 → `conditional` (approve with checklist)
- Priority ≥ 3.5 → `conditional` with weaker market note
- Else → `hold`

## 立项前确认清单（launch-checklist.ts · V1.0）

完整清单见 Skill：`amazon-launch-checklist` 与页面 `/?tab=checklist`。

清单 **10 个大章**（对应《产品立项前确认清单 V1.0》）：

1. 立项基本信息（调研数据自动回填）
2. 市场需求与产品机会 + 市场结论
3. 专利与知识产权（检索 + 风险表 + 红/黄/绿灯）
4. 合规认证（通用 + **七大品类触发式检查** + 结论）
5. 售价与利润空间（全成本表 + 情景测试）
6. MPQ/MOQ 与月销量匹配
7. 供应链可行性
8. 质量、包装与物流
9. 一票否决项（8 条）
10. 立项评分 + 部门会签 + 最终结论

品类垂直：`inferBusinessVertical()` → 灯具 / 户外运动 / 家具 / 家居 / 玩具 / 水上运动 / 园艺 / 通用。

**通过规则**：触发一票否决或硬门槛未通过 → 不得正式下单。

Modules: `launch-checklist.ts`, `launch-checklist-template.ts`, `launch-checklist-section.tsx`.

## Extending for new categories

1. Add merge rules in `server/domain/voc/theme-normalization.ts` for category-specific theme aliases (`app/features/voc/voc-theme-merge.ts` re-exports them)
2. Add/adjust opportunity templates in `app/product-launch-analysis.ts` `buildOpportunities()`
3. Optionally tune supply-chain rows in `buildSupplyRows()` for category BOM realities
4. Re-sync VOC + Sorftime data for new ASINs
5. `npm run build` — verify `/?tab=launch`

## Chat-only analysis

When user asks for analysis without code changes:

1. Run `buildProductLaunchAnalysis` logic mentally from latest synced data files
2. Follow the six sections above
3. Lead with **明确结论** table
4. Never skip cross-analysis — dimension-only summaries are insufficient

## Commands

```bash
npm run review:sync
npm run sales:sync
npm run build
```

Force refresh when MCP data stale:

```bash
npm run review:sync:force
npm run sales:sync:force
```

## UI access

- 立项决策：`/?tab=launch`
- 新产品定义：`/?tab=definition`
- Sidebar: **立项决策** · **新产品定义**
