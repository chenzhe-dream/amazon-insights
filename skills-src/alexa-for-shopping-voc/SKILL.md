---
name: alexa-for-shopping-voc
description: >-
  Parse and format Alexa for Shopping seven-question VOC reports into the
  standardized seven-dimensional matrix (RufusVocRecord). Use when the user
  asks for Alexa for Shopping VOC, Alexa 七问, 七维矩阵录入, VOC 格式化,
  rufus-voc-data, or pastes Alexa/Rufus dialog report text for normalization.
---

# Alexa for Shopping VOC

## Role

Alexa for Shopping VOC 格式化专员。任务是把 **Alexa for Shopping / Rufus 七问回复原文** 解析并规范化为团队统一的 **七维 VOC 核心主题矩阵**（`RufusVocRecord`），供仪表盘展示和后续立项分析使用。

本 Skill 只做 **采集 → 解析 → 格式化 → 交付矩阵**；完整开品建议用 `amazon-voc-insight`，立项决策刷新用 `amazon-product-launch-analysis`。

## When to use

- 用户提供 Alexa for Shopping 对话框回复原文/截图文字，要求录入或格式化
- 用户要求按七维矩阵格式整理 VOC
- 用户提到「Alexa 七问」「七维矩阵」「rufus-voc-data」
- 本仓库需写入 `app/rufus-voc-data.ts` 或调用 `scripts/lib/alexa-voc-pipeline.mjs`

## Alexa 七问 Prompt（固定，勿改）

向 Alexa for Shopping 提交这一句（覆盖七个维度）：

```
这个产品的顾客关注点是什么，好评点是什么，差评点是什么，未被满足的需求是什么，使用人群是谁，使用场景是什么，核心购买动机是什么。
```

## 采集流程

1. **推荐**：Amazon 商品页 → Alexa for Shopping 输入框提交七问 → 展开 **See more** → 复制全文
2. **本仓库自动**：`npm run alexa:capture -- ASIN` 或竞品概览「开始全自动分析」
3. **手工录入**：仪表盘「Alexa 七问 · 快速录入」粘贴全文，或 `POST /api/alexa-voc/import`

数据源范围：**Customer Review（经 Alexa 整理）**；不是 Listing Bullet Point，也不是 Customers say 标签页。

## Workflow

```
Progress:
- [ ] 1. 确认 ASIN、评分、评论数（从报告页眉或用户提供）
- [ ] 2. 按 1️⃣–7️⃣ 分段解析原文
- [ ] 3. 规范化为七维矩阵字符串格式
- [ ] 4. 提取总体结论（8️⃣ / 总体结论段）
- [ ] 5. 组装 RufusVocRecord 并交付
- [ ] 6. （可选）写入 rufus-voc-data.ts
```

### Step 1 — 解析原文分段

识别以下段落标记（桌面 Rufus / 手机 Alexa 均可能出现）：

| 维度 | 字段 | 段落标记 |
|------|------|----------|
| 顾客关注点 | `attention` | `1️⃣ 顾客关注点` / `📌 1. 顾客关注点` |
| 好评点 | `positives` | `2️⃣ 好评点` / `✅ 2. 好评点` |
| 差评点 | `negatives` | `3️⃣ 差评点` / `❌ 3. 差评点` |
| 未被满足的需求 | `unmet` | `4️⃣ 未被满足的需求` |
| 使用人群 | `audiences` | `5️⃣ 使用人群` |
| 使用场景 | `scenarios` | `6️⃣ 使用场景` |
| 核心购买动机 | `motives` | `7️⃣ 核心购买动机` / `7️⃣ 购买动机` |

跳过行：`Alexa is generating`、`正在生成`、`Ask Alexa`、`Customer Review` 页眉噪声。

总体结论：提取 `8️⃣ 总体结论` / `总体结论` / `综合结论` 段，写入 `alexaReport.overallConclusion`。

### Step 2 — 规范化为矩阵字符串

**必须严格按下列模板输出**（详见 [matrix-format.md](references/matrix-format.md)）：

| 维度 | 格式 |
|------|------|
| 顾客关注点 | `{序号}. {标题}：{详情}（{维度} {N} 条提及，约 {X}%）。` |
| 好评点 | `【{标签}】约 {X}% 评论提及（{N} 条）` |
| 差评点 | `【{标签}】约 {X}% 评论提及（{N} 条）` |
| 未满足需求 | `{序号}. {需求描述}。` |
| 使用人群 | 表头 `人群分类｜特征` + 数据行 |
| 使用场景 | 表头 `场景｜说明与示例` + 数据行 |
| 购买动机 | 表头 `动机｜重要性｜说明` + 数据行（重要性用 ⭐） |

**百分比规则**：`pct = mentions / reviewCount × 100`；≥1% 保留 1 位小数，<1% 保留 2 位小数。条数用千分位（如 `1,264`）。

**条数上限**：关注点 ≤8、好评 ≤10、差评 ≤8、未满足 ≤8。

缺 mention 统计时：保留语义内容，占比标「暂无数据」，禁止编造数字。

### Step 3 — 组装 RufusVocRecord

```typescript
type RufusVocRecord = {
  attention: string[];
  positives: string[];
  negatives: string[];
  unmet: string[];
  audiences: string[];
  scenarios: string[];
  motives: string[];
  captureStatus?: "dialog" | "pending";
  alexaReport?: {
    title: "顾客评价深度分析";
    asin: string;
    rating: number;
    reviewCount: number;
    starBreakdown?: string;
    prompt: string;           // 固定七问 prompt
    overallConclusion: string;
    captureNote?: string;
    captureStatus?: "dialog" | "pending";
  };
};
```

`captureNote` 格式：`来源：Alexa for Shopping 对话框七问回复（YYYY-MM-DD）` 或 `对话框粘贴录入` / `自动抓取`。

## Output format（严格按序）

1. **报告页眉** — ASIN、评分、评论数、星级分布、总体结论（1 段）
2. **七维 VOC 核心主题矩阵** — 七个区块，每块按上述字符串格式列出
3. **数据质量说明** — 哪些维度缺失、是否含 mention 统计、置信度
4. **（可选）TypeScript 片段** — 可直接写入 `rufusVocData[ASIN]` 的对象

Chat 交付用 Markdown 表格 + 编号列表即可；写入代码时用 TypeScript 对象。

## Hard rules

1. 七个维度字段名固定：`attention` / `positives` / `negatives` / `unmet` / `audiences` / `scenarios` / `motives`
2. 分隔符统一用全角 `｜`，不用半角 `|`
3. 标签用中文方括号 `【】`
4. 无数据维度写「暂无数据」，禁止用滑板车/类目专属句式硬套（读 `productFamily`，未知类目用 generic 表述）
5. 不得把 Listing Bullet、Customers say 内容冒充 Alexa 七问结果
6. 本仓库写入时优先调用既有 pipeline，不手写一次性格式

## Project integration

| 操作 | 路径 / 命令 |
|------|-------------|
| 读取已录入矩阵 | `app/rufus-voc-data.ts` |
| 解析 + 规范化 | `scripts/lib/parse-alexa-voc-report.mjs` → `normalize-alexa-voc-sections.mjs` |
| 一键入库 | `saveAlexaVocToSystem()` in `scripts/lib/alexa-voc-pipeline.mjs` |
| API 粘贴录入 | `app/api/alexa-voc/import/route.ts` |
| 格式样例 | [examples.md](references/examples.md) |

有 ASIN + 原文时，优先运行：

```bash
node scripts/run-alexa-voc-capture.mjs --import-only ASIN
# 或粘贴模式见 alexa-voc-import-panel
```

若用户仅要格式化、不入库：按 Output format 交付 Markdown 矩阵即可。

## Related skills

- `amazon-voc-insight` — 七维 VOC → 开品建议（七段分析报告）
- `define-amazon-voc-positioning` — 三表合并 → 单款产品定位
- `amazon-product-launch-analysis` — 仪表盘立项决策刷新
