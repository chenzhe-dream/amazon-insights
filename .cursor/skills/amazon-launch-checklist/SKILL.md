---
name: amazon-launch-checklist
description: >-
  Build and refresh the Amazon product pre-launch confirmation checklist (产品立项前确认清单 V1.0)
  with competitor category data, VOC signals, Sorftime sales, and vertical-specific compliance rows.
  Use when updating 立项前确认清单, extending checklist sections, mapping a new category vertical,
  or filling checklist items from competitor research in the dashboard or chat.
---

# Amazon 产品立项前确认清单（V1.0）

## When to use

- User asks for **立项前确认清单**, **打样前确认**, **一票否决**, or **合规硬门槛**
- Refresh checklist after new competitor ASINs or VOC sync
- Extend checklist for a new vertical (水上运动、园艺等)
- Chat output should mirror `/?tab=checklist` page structure

## Source of truth

| Asset | Role |
|-------|------|
| `产品立项前确认清单 (1).md` | Business template V1.0（十个大章） |
| `app/features/product-reports/launch-checklist-template.ts` | 否决项、评分维度、七大品类合规矩阵 |
| `app/features/product-reports/launch-checklist.ts` | **Engine** — vertical inference + research context + section builder |
| `app/features/product-reports/launch-checklist-section.tsx` | **UI** for `/?tab=checklist` |
| `app/features/product-reports/product-launch-analysis.ts` | Feeds VOC/market into checklist via `buildLaunchChecklist()` |

Do **not** duplicate checklist prose in UI components. All sections flow from `buildLaunchChecklist()`.

## Checklist structure (10 sections)

1. **立项基本信息** — auto-fill category, ASINs, audience/scenarios from VOC
2. **市场需求与产品机会** — 10 checks + 市场结论（人工判定）
3. **专利与知识产权** — 检索范围 + 风险表 + 红/黄/绿灯规则
4. **合规认证与产品安全** — 通用 10 项 + **七大品类触发式检查**（按 `inferBusinessVertical()` 匹配一行）+ 合规结论
5. **售价区间与利润空间** — 市场售价 + 全成本表 + 情景压力测试 + 15% 基准线
6. **MPQ/MOQ 与预估月销量** — 起订条件表 + 预测依据 + 2/3 个月售完规则
7. **产品方案与供应链可行性** — 10 项
8. **质量、包装与物流** — 8 项
9. **立项一票否决项** — 8 条，任一触发原则上不得正式下单
10. **立项评分与审批** — 8 维加权评分表 + 部门会签 + 最终结论

## Category verticals

`inferBusinessVertical()` maps competitor corpus (title + subRankCategory) to:

| Key | Label |
|-----|-------|
| `outdoor` | 户外运动 |
| `toys` | 玩具 |
| `lighting` | 灯具 |
| `furniture` | 家具 |
| `home` | 家居 |
| `water_sports` | 水上运动 |
| `garden` | 园艺 |
| `general` | 通用（fallback） |

Section **四·七大品类触发式检查** shows the matched row from `complianceCategoryMatrix`.

To add a vertical: extend `VERTICAL_PATTERNS`, `businessVerticalLabels`, and `complianceCategoryMatrix`.

## Research auto-fill fields

`buildLaunchChecklist()` accepts and surfaces:

- `categoryLabel` — 细分类目节点（来自竞品 subRankCategory）
- `products[]` — ASIN, brand, title, price, sales
- VOC tops — attention, negative, unmet, motives, audiences, scenarios
- `opportunities[0].name` — 首要机会方向
- `targetPrice` — 来自 `buildProductDefinition()`
- `priceBand`, `sampleSales`, `dataMonth` — 来自 `buildMarketContext()`
- `verdictTitle` — 来自 VOC 立项分析结论

These populate **调研数据回填** card and `dataHints` under relevant sections.

## Hard gates (must enforce in chat)

**专利：** 红灯暂停立项；黄灯需专业复核；绿灯需完整检索记录。

**合规：** 不能只采纳供应商口头判断；美国站儿童玩具、FCC、TSCA、FIFRA 等按产品触发。

**利润：** 公司立项线 = 基准情景平台毛利润率 ≥ 15%；低于 15% 且无降本方案 → 一票否决。

**MPQ：** 保守销量下单 SKU MPQ 售完周期 — 绿灯 ≤2 月，黄灯 2–3 月，红灯 >3 月。

**一票否决：** 见 `vetoItems` in template — 无论评分多高，触发则不得直接立项。

## Scoring (section 十)

| 分数 | 建议 |
|------|------|
| ≥80 | 建议立项 |
| 65–79 | 有条件立项 |
| 50–64 | 继续调研或小批量测试 |
| <50 | 暂不立项 |

Weights: 市场 15%、VOC 15%、专利 15%、合规 15%、利润 15%、MPQ 10%、供应链 10%、物流 5%。

## Workflow to refresh checklist

1. Confirm competitor ASINs in catalog
2. Sync VOC (`rufus-voc-data`) + Sorftime review/sales if stale
3. Update `buildLaunchChecklist()` inputs in `buildProductLaunchAnalysis()` if new signals needed
4. `npm run build` + restart team server
5. Verify `http://<lan>:3000/?tab=checklist`

## Chat output format

When user requests checklist in chat without code changes:

1. State **识别品类** + **对标 ASIN 数** + **售价带/样本月销**
2. List **调研数据回填** bullets (VOC tops, opportunity, target price)
3. Walk through **sections 二–九** highlighting items already supported by research vs still manual
4. Call out **品类合规专项** row for inferred vertical
5. End with **一票否决** scan and **评分/会签** reminder

## UI access

- 立项前确认清单：`/?tab=checklist`
- Related: VOC 立项分析 `/?tab=launch` · 新产品定义 `/?tab=definition`

## Commands

```bash
npm run review:sync
npm run sales:sync
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\start-team-server.ps1
```
