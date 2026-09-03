# Alexa 真实七问报告兼容性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让业务人员可将 Alexa for Shopping 的完整七问原文直接粘贴导入，稳定解析七维、保留指标原义，并在写入前给出无敏感信息的可诊断错误。

**Architecture:** 解析器先在单个 section 边界内把原文变成带来源与列的中间记录，规范化器再把这些记录转换为既有 `rufus-voc-data.ts` 使用的字符串矩阵。管线在任何原子提交之前完成 ASIN、限额、七维完整度和诊断计算；路由与 UI 只展示服务端提供的标准维度诊断，继续使用既有后台 Artifact 发布流程。

**Tech Stack:** Node.js 22 ESM、TypeScript/React、Node test runner、tsx、ESLint、现有 Alexa VOC 原子发布模块。

## Global Constraints

- 仅支持用户已提交的本地 UTF-8 文本；不得调用 LLM、第三方 API、Alexa、Amazon、浏览器或任何网络服务。
- 输入上限保持为 128 KiB、1,000 行、单行 2,048 字符、表格最多 256 行；空白输入为 400。
- 选择 ASIN 与报告内 10 位 ASIN 不一致时，必须在 cache、`app/rufus-voc-data.ts`、快照、publication state 和发布请求之前以 422 拒绝。
- 七维 key 固定为 `attention`、`positives`、`negatives`、`unmet`、`audiences`、`scenarios`、`motives`；仅规范化后的非空维度计数，少于 3 维继续拒绝。
- 真实格式 fixture 必须为脱敏、结构等价的虚构品牌与测试 ASIN；不得提交用户原始报告、真实 ASIN、品牌、价格或评论原话。
- 好评率、差评率、提及次数、Q&A 条数、星级、`部分`、`不详`必须保留原义；不得把好/差评率伪装成评论提及率，也不得用 catalog 评论数改写这些指标。
- 保留 `parseAlexaVocReport(rawText, asinHint)`、`normalizeAlexaVocSections(sections, options)`、`processAlexaVocText`、`saveAlexaVocToSystem` 的调用方式、旧格式标题、Tab/全角 `｜` 表格、编号列表、`overallConclusion` 与既有发布顺序。
- 全部测试仅使用临时目录、依赖注入和 fixture；不启动真实服务、不写正式端口、不运行真实构建/重载、不访问 provider。
- 保留现有用户 WIP；禁止 `git add .`、`git reset`、`git checkout`、`git clean`、`git stash`、`git rebase`、`git commit --amend`。
- 每个任务仅暂存其列出的文件；每次提交前对变更文件运行 ESLint。全仓 `npm run lint` 如仍因既有基线失败，只记录结果，不把基线问题归因于本改动。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `tests/fixtures/alexa-real-report-anonymized.txt` | 虚构/脱敏但结构等价的 Alexa 完整七问原文；覆盖无序号 emoji 标题、纵向表格、Markdown 表格、分行编号、总结尾部。 |
| `scripts/lib/parse-alexa-voc-report.mjs` | 导出七维定义；按严格标题语法扫描 section 边界；产生不跨 section 的结构记录和标题检测结果；兼容旧格式首部/标题。 |
| `tests/scripts/parse-alexa-voc-report.test.mjs` | 直接锁定标题变体、边界、三种结构、重复块去重、ASIN 变体与总结隔离。 |
| `scripts/lib/normalize-alexa-voc-sections.mjs` | 接收结构记录或旧字符串数组，生成旧矩阵字符串，区分评论提及率与好/差评率。 |
| `tests/scripts/normalize-alexa-voc-sections.test.mjs` | 锁定指标保真、列不借位、Markdown/纵向/编号记录和旧格式兼容。 |
| `scripts/lib/alexa-voc-pipeline.mjs` | 将检测/无效维度变成稳定诊断，在原子提交前执行所有拒绝条件并保留现有返回字段。 |
| `tests/alexa-voc-import-validation.test.ts` | 在临时 worktree 验证真实 fixture 的 `7/7`、投影/缓存写入、旧报告、ASIN 零写入与限额。 |
| `app/api/alexa-voc/import/route.ts` | 将结构化完整度错误转为不回显正文的 422 JSON；成功响应返回非敏感诊断。 |
| `tests/agent/alexa-voc-mutation-routes.test.ts` | 验证路由 422 的稳定前缀、检测/缺失名、无 sentinel/原文泄漏和成功诊断字段。 |
| `app/alexa-voc-import-panel.tsx` | 说明可原样粘贴真实 Alexa 回复，更新 placeholder，并显示服务端诊断，不在浏览器端解析。 |

## Shared Interfaces

`scripts/lib/parse-alexa-voc-report.mjs` 必须导出下列稳定定义，后续任务只使用这些名称：

```js
export const ALEXA_VOC_DIMENSIONS = Object.freeze([
  { key: "attention", label: "顾客关注点" },
  { key: "positives", label: "好评点" },
  { key: "negatives", label: "差评点" },
  { key: "unmet", label: "未被满足的需求" },
  { key: "audiences", label: "使用人群" },
  { key: "scenarios", label: "使用场景" },
  { key: "motives", label: "核心购买动机" },
]);

// ParsedSectionRecord: { kind: "text" | "table", source: "table" | "vertical" | "numbered" | "prose", text: string, cells: string[], lineStart: number }
// parseAlexaVocReport(rawText: string, asinHint?: string): {
//   asin: string, rating: number|null, reviewCount: number|null, starBreakdown?: string,
//   overallConclusion: string, sections: Record<string, ParsedSectionRecord[]>,
//   detectedKeys: string[], rawLineCount: number, ok: boolean, missing: string[]
// }
```

管线保持原字段，并只增加以下字段：

```js
// processAlexaVocText(...) 与 saveAlexaVocToSystem(...) 返回：
// { filled: number, missing: string[], detected: string[], invalid: string[], sections: Record<string, string[]>, ...existingFields }
```

其中 `missing` 保持 key 数组以兼容当前调用方；`detected` 与 `invalid` 是标准中文维度名数组，`invalid` 仅含“标题存在但规范化后无有效条目”的维度。

### Task 1: 脱敏真实 fixture 与严格分段/结构记录解析

**Files:**
- Create: `tests/fixtures/alexa-real-report-anonymized.txt`
- Create: `tests/scripts/parse-alexa-voc-report.test.mjs`
- Modify: `scripts/lib/parse-alexa-voc-report.mjs`

**Interfaces:**
- Consumes: `parseAlexaVocReport(rawText, asinHint)` 的现有调用方式。
- Produces: `ALEXA_VOC_DIMENSIONS` 与 `ParsedSectionRecord[]` section 输出，供 Task 2 的 `normalizeAlexaVocSections` 消费。

- [ ] **Step 1: 创建不含真实业务信息的完整 fixture**

在 `tests/fixtures/alexa-real-report-anonymized.txt` 写入虚构首部 `示例品牌 可调设备 (B0ALEXA001) — 完整顾客行为分析`，并使用下列骨架；所有商品名、金额、评论措辞和数值必须是虚构值，保留结构而非用户原文：

```text
🎯 顾客关注点 (客户最在乎什么)
排序
关注点
提及次数
为什么重要
#1
耐用表现
137次
影响长期使用感受
✅ 好评点（为什么给好评）
特性
好评率
核心评价
典型评论
材质
82% ⭐⭐⭐⭐⭐
质感可靠
示例好评甲
❌ 3. 差评点 (为什么不满意)
问题
差评率
投诉内容
受影响群体
控制失灵
7%
示例故障
部分用户
亮度不足
部分
示例亮度不足
阅读用户
💭 未被满足的需求 (顾客想要但没有的功能)
1.
更宽的调节范围
• 现状：最低档仍偏亮
• 需求：支持更暗模式
👥 使用人群 (谁在买)
1.
预算型用户
• 需求：成本可控且易安装
🏠 使用场景：
| 场景 | 使用率 | 典型用法 | 用户类型 |
| --- | :---: | --- | --- |
| 书房工作 | ⭐⭐⭐⭐ | 夜间专注 | 办公用户 |
⚡ 核心购买动机 (为什么决定购买)
🔴 #1
价格驱动
• 重要性：⭐⭐⭐⭐⭐
• 说明：预算内获得核心功能
💡 综合结论
仅用于验证总结不会进入七维。
```

- [ ] **Step 2: 写 parser RED 测试，覆盖真实格式而非手改格式**

在 `tests/scripts/parse-alexa-voc-report.test.mjs` 读取 fixture，先断言目前实现失败（当前应为 `sections` 中缺少至少一个维度或非结构记录）：

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ALEXA_VOC_DIMENSIONS, parseAlexaVocReport } from "../../scripts/lib/parse-alexa-voc-report.mjs";

const fixture = fs.readFileSync(path.resolve("tests/fixtures/alexa-real-report-anonymized.txt"), "utf8");
const keys = ALEXA_VOC_DIMENSIONS.map(({ key }) => key);

test("real Alexa fixture recognizes seven headings and keeps records inside their sections", () => {
  const parsed = parseAlexaVocReport(fixture);
  assert.equal(parsed.asin, "B0ALEXA001");
  assert.deepEqual(parsed.detectedKeys, keys);
  assert.deepEqual(Object.keys(parsed.sections).sort(), [...keys].sort());
  for (const key of keys) assert.ok(parsed.sections[key].length > 0, key);
  assert.deepEqual(parsed.missing, []);
  assert.ok(parsed.sections.attention.some(record => record.source === "vertical" && record.cells[1] === "耐用表现"));
  assert.ok(parsed.sections.scenarios.some(record => record.source === "table" && record.cells[0] === "书房工作"));
  assert.ok(parsed.sections.unmet.some(record => record.source === "numbered" && record.text.includes("现状：最低档仍偏亮") && record.text.includes("需求：支持更暗模式")));
  assert.ok(!parsed.sections.motives.some(record => record.text.includes("仅用于验证总结")));
});

test("heading matcher accepts real variants but rejects prose and summary headings", () => {
  const text = [
    "B0ALEXA001 — 完整顾客行为分析", "顾客关注点是什么不应是标题", "🎯 顾客关注点 (客户最在乎什么)", "1. 可靠性",
    "✅ 好评点（为什么给好评）", "1. 好用", "❌ 3. 差评点", "1. 偏重", "💭 未被满足", "1. 更轻",
    "## 使用人群：", "1. 新手", "使用场景是什么不应是标题", "## 使用场景：", "1. 家中", "7️⃣ 购买动机", "1. 省时", "综合结论", "好评点包括但不应计数",
  ].join("\n");
  const parsed = parseAlexaVocReport(text);
  assert.deepEqual(parsed.detectedKeys, keys);
  assert.ok(!parsed.sections.motives.some(record => record.text.includes("好评点包括")));
});

test("repeated section blocks append in document order and deduplicate identical records", () => {
  const parsed = parseAlexaVocReport(["B0ALEXA001", "顾客关注点", "1. 可靠性", "顾客关注点", "1. 可靠性", "2. 易安装"].join("\\n"));
  assert.deepEqual(parsed.sections.attention.map(record => record.text), ["可靠性", "易安装"]);
});
```

- [ ] **Step 3: 运行 RED 测试并确认失败原因是现有格式不兼容**

Run: `node --test tests/scripts/parse-alexa-voc-report.test.mjs`  
Expected: FAIL；当前模块未导出 `ALEXA_VOC_DIMENSIONS`，且无序号真实标题/纵向表格不能得到完整七维结构记录。

- [ ] **Step 4: 实现一次标题扫描、严格边界和结构记录构建**

在 `scripts/lib/parse-alexa-voc-report.mjs` 用下列常量替换仅依赖特定 emoji 的 `SECTIONS`；标题只接受可选 Markdown/emoji/编号前缀后的行首标准名和允许尾缀，绝不对正文子串匹配：

```js
export const ALEXA_VOC_DIMENSIONS = Object.freeze([
  { key: "attention", label: "顾客关注点", aliases: ["顾客关注点"] },
  { key: "positives", label: "好评点", aliases: ["好评点"] },
  { key: "negatives", label: "差评点", aliases: ["差评点"] },
  { key: "unmet", label: "未被满足的需求", aliases: ["未被满足的需求", "未被满足"] },
  { key: "audiences", label: "使用人群", aliases: ["使用人群"] },
  { key: "scenarios", label: "使用场景", aliases: ["使用场景"] },
  { key: "motives", label: "核心购买动机", aliases: ["核心购买动机", "购买动机"] },
]);

const SUMMARY_START = /^(?:💡\s*)?(?:综合结论|总体结论|Conditions of Use|©\s|来源[:：])/i;
const HEADING_PREFIX = /^(?:#{1,6}\s*)?(?:[\p{Extended_Pictographic}\uFE0F\u20E3]+\s*)?(?:(?:[1-7]️⃣|[1-7])\s*[.、)）:：-—]?\s*)?/u;
const HEADING_SUFFIX = /^(?:\s*(?:[:：\-—])?\s*(?:\([^)]*\)|（[^）]*）)?\s*)$/u;

function sectionHeading(line) {
  const remainder = line.trim().replace(HEADING_PREFIX, "");
  for (const dimension of ALEXA_VOC_DIMENSIONS) {
    for (const alias of dimension.aliases) {
      if (remainder.startsWith(alias) && HEADING_SUFFIX.test(remainder.slice(alias.length))) return dimension.key;
    }
  }
  return null;
}
```

把 `normalizeLines` 改为保留 `{ text, lineNumber }`，一次扫描所有标题并按行号排序；同 key 后续区块追加到其数组，按 `kind + cells/text` 去重。每一块只取“标题下一行至下一个已识别七维标题前”，最后一块遇到 `SUMMARY_START` 停止。首部 ASIN 使用 `/[（(]([A-Z0-9]{10})[）)]\s*[—-]\s*完整顾客行为分析/i` 与已有任意 ASIN 回退共同匹配。

在 section 内按固定优先级建立记录，已消费行绝不可再消费：

```js
function tableCells(line) {
  const source = line.includes("\t") ? "\t" : line.includes("｜") ? "｜" : line.includes("|") ? "|" : null;
  if (!source) return null;
  const cells = (source === "|" ? line.replace(/^\||\|$/g, "").split("|") : line.split(source)).map(value => value.trim());
  return cells.every(value => /^:?-{3,}:?$/.test(value) || value === "") ? null : cells;
}

function record(kind, source, text, cells, lineStart) {
  return { kind, source, text: text.trim(), cells: cells.map(value => value.trim()), lineStart };
}
```

实现 `parseSectionRecords(key, lines)`：先识别并保留最少列数足够的 Tab/全角/Markdown 行；再根据该 key 的完整纵向表头（`attention` 4 列、`positives` 4 列、`negatives` 4 列、`audiences`/`scenarios` 4 列、`motives` 3 列）每 N 个连续单元格组成一条 `source: "vertical"` 记录，尾部不足 N 个恢复为普通文本；再合并 `1.`、`1、`、`1)`、`#1`、`🔴 #1` 或独立编号后的首个文本和 `•`/`-` 子项为 `source: "numbered"`；最后以 `source: "prose"` 保存长度大于 1 的普通行。生成的 `sections` 只含记录，旧格式的普通行也作为 `prose`/`numbered` 记录进入，不能丢失。

- [ ] **Step 5: 运行 parser 测试并确认通过**

Run: `node --test tests/scripts/parse-alexa-voc-report.test.mjs`  
Expected: PASS；fixture 的 ASIN 为 `B0ALEXA001`、`detectedKeys` 为七个固定 key、每个维度至少一个记录，且综合结论未进入动机。

- [ ] **Step 6: 对本任务变更运行 ESLint 并提交**

Run: `npx eslint scripts/lib/parse-alexa-voc-report.mjs tests/scripts/parse-alexa-voc-report.test.mjs`  
Expected: PASS with exit code 0.

```bash
git add tests/fixtures/alexa-real-report-anonymized.txt tests/scripts/parse-alexa-voc-report.test.mjs scripts/lib/parse-alexa-voc-report.mjs
git commit -m "feat(voc): parse real Alexa report structures"
```

### Task 2: 指标保真规范化与旧格式兼容

**Files:**
- Create: `tests/scripts/normalize-alexa-voc-sections.test.mjs`
- Modify: `scripts/lib/normalize-alexa-voc-sections.mjs`

**Interfaces:**
- Consumes: Task 1 的 `ParsedSectionRecord[]`，并继续接受旧调用方传入的 `string[]`。
- Produces: `normalizeAlexaVocSections(sections, { reviewCount })` 的既有七个 `string[]`，供 Task 3 的 pipeline 使用。

- [ ] **Step 1: 写 normalizer RED 测试，锁定指标语义、列绑定和旧格式**

在 `tests/scripts/normalize-alexa-voc-sections.test.mjs` 使用 fixture 的 parser 输出以及显式旧格式输入：

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizeAlexaVocSections } from "../../scripts/lib/normalize-alexa-voc-sections.mjs";
import { parseAlexaVocReport } from "../../scripts/lib/parse-alexa-voc-report.mjs";

const fixture = fs.readFileSync(path.resolve("tests/fixtures/alexa-real-report-anonymized.txt"), "utf8");

test("normalizes real Alexa records without changing metric meaning or column ownership", () => {
  const normalized = normalizeAlexaVocSections(parseAlexaVocReport(fixture).sections, { reviewCount: 999 });
  assert.match(normalized.attention.join("\n"), /137次/);
  assert.match(normalized.positives.join("\n"), /【材质】好评率 82%/);
  assert.doesNotMatch(normalized.positives.join("\n"), /82% 评论提及/);
  assert.match(normalized.negatives.join("\n"), /【控制失灵】差评率 7%/);
  assert.match(normalized.negatives.join("\n"), /部分/);
  assert.match(normalized.scenarios.join("\n"), /书房工作｜⭐⭐⭐⭐｜夜间专注｜办公用户/);
  assert.match(normalized.unmet.join("\n"), /现状：最低档仍偏亮.*需求：支持更暗模式/);
  assert.match(normalized.motives.join("\n"), /价格驱动｜⭐⭐⭐⭐⭐｜.*预算内获得核心功能/);
});

test("retains legacy mention formatting and rejects incomplete vertical rows", () => {
  const legacy = normalizeAlexaVocSections({
    positives: ["质量可靠（好评维度10次提及，20%）"],
    negatives: ["包装有待改善（差评维度5次提及，10%）"],
  }, { reviewCount: 100 });
  assert.deepEqual(legacy.positives, ["【质量可靠】约 10.0% 评论提及（10 条）"]);
  assert.deepEqual(legacy.negatives, ["【包装有待改善】约 5.0% 评论提及（5 条）"]);
  const incomplete = normalizeAlexaVocSections({ positives: [{ kind: "table", source: "vertical", text: "", cells: ["错位标签", "82%"], lineStart: 1 }] });
  assert.deepEqual(incomplete.positives, []);
});
```

- [ ] **Step 2: 运行 RED 测试并确认当前实现不能消费结构记录或保留好/差评率语义**

Run: `node --test tests/scripts/normalize-alexa-voc-sections.test.mjs`  
Expected: FAIL；当前 normalizer 对对象调用 `trim()`，并把真实表格中的好评率/差评率漏掉或误用旧的评论提及格式。

- [ ] **Step 3: 实现记录兼容层和按来源词格式化**

在 `scripts/lib/normalize-alexa-voc-sections.mjs` 先将旧 `string[]` 提升为普通记录，避免改变旧调用方接口：

```js
function asRecords(value = []) {
  return value.map((item, index) => typeof item === "string"
    ? { kind: "text", source: "prose", text: item.trim(), cells: [item.trim()], lineStart: index + 1 }
    : item,
  ).filter(item => item && typeof item.text === "string");
}

function exactRate(value, name) {
  const rate = String(value ?? "").trim();
  return rate && rate !== "部分" && rate !== "不详" ? `${name} ${rate}` : rate;
}

function formatRatedTheme(cells, rateName) {
  const [label, rate, evaluation = "", example = ""] = cells;
  if (![label, rate, evaluation, example].every(Boolean)) return null;
  return `【${label}】${exactRate(rate, rateName)} · ${evaluation} · ${example}`;
}
```

让 `normalizePositives` 和 `normalizeNegatives` 先消费完整的 4 列 `table`/`vertical` 记录，分别调用 `formatRatedTheme(record.cells, "好评率")` 与 `formatRatedTheme(record.cells, "差评率")`；`部分`/`不详` 保留为 `【标签】部分 · …` 或 `【标签】不详 · …`，不调用 `vocPct`。只有旧字符串命中既有 `parseThemeStats` 时才走 `formatPositive`/`formatNegative` 的评论提及逻辑。

让 `normalizeAttention` 对 4 列记录生成 `N. 关注点（提及次数：137次；为什么重要：…）。`，绝不以 `reviewCount` 改写原始提及次数或 Q&A 条数。让人群/场景/动机将表格记录统一为全角 `｜`，在缺失单元格时保留空列但仅接受最低列数完整的记录；动机将第二列 `★`/`⭐` 统一为同数量 `⭐`。让 `unmet`、人群、场景、动机的编号记录按 Task 1 合并后的 `text` 生成一条项目/表格行，说明使用 ` · `，但不拆开“现状”“需求”“对标”。

- [ ] **Step 4: 运行 normalizer 与 parser 回归测试**

Run: `node --test tests/scripts/normalize-alexa-voc-sections.test.mjs tests/scripts/parse-alexa-voc-report.test.mjs`  
Expected: PASS；`82%` 仅标记为好评率、`7%` 仅标记为差评率、`137次` 保留次数、Markdown 行变为 `｜`、旧报告继续使用评论提及格式。

- [ ] **Step 5: 对本任务变更运行 ESLint 并提交**

Run: `npx eslint scripts/lib/normalize-alexa-voc-sections.mjs tests/scripts/normalize-alexa-voc-sections.test.mjs`  
Expected: PASS with exit code 0.

```bash
git add scripts/lib/normalize-alexa-voc-sections.mjs tests/scripts/normalize-alexa-voc-sections.test.mjs
git commit -m "feat(voc): preserve Alexa review metric semantics"
```

### Task 3: 写入前诊断、422 映射与页面引导

**Files:**
- Modify: `scripts/lib/alexa-voc-pipeline.mjs`
- Modify: `app/api/alexa-voc/import/route.ts`
- Modify: `app/alexa-voc-import-panel.tsx`
- Modify: `tests/alexa-voc-import-validation.test.ts`
- Modify: `tests/agent/alexa-voc-mutation-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ALEXA_VOC_DIMENSIONS`/`detectedKeys` 与 Task 2 的七维规范化数组。
- Produces: 保留现有字段的 pipeline 结果，新增 `detected: string[]`、`invalid: string[]`；导入路由的安全 JSON 诊断与 UI 展示。

- [ ] **Step 1: 写 pipeline RED 测试，验证真实 fixture 7/7、临时 worktree 写入和失败零写入**

扩展 `tests/alexa-voc-import-validation.test.ts`，读取 fixture，使用临时 `worktree`（沿用已有目录/复制模式），并加入如下断言：

```ts
const realFixture = fs.readFileSync(path.resolve("tests/fixtures/alexa-real-report-anonymized.txt"), "utf8");
const fixtureAsin = "B0ALEXA001";

test("real Alexa fixture writes all seven normalized dimensions in a temporary worktree", () => {
  const worktree = createTemporaryAlexaWorktree();
  try {
    const result = saveAlexaVocToSystem(fixtureAsin, realFixture, { worktree, capturedAt: "2026-08-30" });
    assert.equal(result.filled, 7);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.invalid, []);
    assert.deepEqual(result.detected, ["顾客关注点", "好评点", "差评点", "未被满足的需求", "使用人群", "使用场景", "核心购买动机"]);
    assert.equal(fs.readFileSync(path.join(worktree, "data", "alexa-voc-cache", `${fixtureAsin}.txt`), "utf8"), realFixture.trim());
    const projection = fs.readFileSync(path.join(worktree, "app", "rufus-voc-data.ts"), "utf8");
    assert.match(projection, /好评率 82%/);
    assert.match(projection, /差评率 7%/);
  } finally { fs.rmSync(worktree, { recursive: true, force: true }); }
});

test("incomplete real-format report reports only dimension labels and changes no target", () => {
  const worktree = createTemporaryAlexaWorktree();
  const sentinel = "RAW-REPORT-SECRET-SENTINEL";
  const before = snapshotAlexaTargets(worktree, fixtureAsin);
  try {
    assert.throws(() => saveAlexaVocToSystem(fixtureAsin, `B0ALEXA001 — 完整顾客行为分析\n🎯 顾客关注点\n1. 有效内容\n💡 综合结论\n${sentinel}`, { worktree }),
      /incomplete_report；检测到：顾客关注点；缺失：好评点、差评点、未被满足的需求、使用人群、使用场景、核心购买动机/);
    assert.deepEqual(snapshotAlexaTargets(worktree, fixtureAsin), before);
  } finally { fs.rmSync(worktree, { recursive: true, force: true }); }
});

test("markdown table rows obey the existing 256-row limit before any publication state exists", () => {
  const worktree = createTemporaryAlexaWorktree();
  const report = [
    `${fixtureAsin} — 完整顾客行为分析`, "🏠 使用场景", "| 场景 | 说明 |", "| --- | --- |",
    ...Array.from({ length: 257 }, (_, index) => `| 场景${index} | 说明${index} |`),
  ].join("\\n");
  try {
    assert.throws(() => saveAlexaVocToSystem(fixtureAsin, report, { worktree }), { message: "report_limits_table_rows" });
    assert.equal(fs.existsSync(path.join(worktree, "data", "alexa-publication-state.json")), false);
  } finally { fs.rmSync(worktree, { recursive: true, force: true }); }
});
```

在同一测试文件中实现明确的本地 helper `createTemporaryAlexaWorktree()` 和 `snapshotAlexaTargets()`：前者复制已有测试所需的 `app/rufus-voc-data.ts`、`app/competitor-data.ts` 及空 `package.json`/runner 占位文件；后者读取/比较 cache、投影、snapshot、publication state 的 Buffer/缺失状态。不得调用真实工作树写入。

- [ ] **Step 2: 写路由 RED 测试，锁定无敏感诊断与成功字段**

在 `tests/agent/alexa-voc-mutation-routes.test.ts` 把现有 incomplete 测试替换/扩展为：

```ts
test("Alexa import maps structured incomplete diagnostics to safe 422 JSON", async () => {
  const rawSentinel = "RAW-REPORT-SECRET-SENTINEL";
  const handler = createAlexaVocImportHandler({
    authorize: authorized,
    save: () => { throw new Error("incomplete_report；检测到：顾客关注点、好评点；缺失：差评点、未被满足的需求、使用人群、使用场景、核心购买动机；无效：好评点（内容未形成有效条目）"); },
  });
  const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", { method: "POST", body: JSON.stringify({ asin: "B0T2TASK02", text: rawSentinel }) }));
  const body = await response.json() as { error: string; detected?: string[]; invalid?: string[] };
  assert.equal(response.status, 422);
  assert.match(body.error, /^Alexa 报告至少需要识别 3 个维度；检测到：顾客关注点、好评点；缺失：/);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(rawSentinel));
});

test("Alexa import returns server diagnostics only after a successful write", async () => {
  const handler = createAlexaVocImportHandler({ authorize: authorized, save: () => ({ ...completeSavedReport, detected: ["顾客关注点", "好评点", "差评点"], invalid: [] }), rebuild: () => ({ started: false, message: "skipped" }) });
  const response = await handler(new Request("http://127.0.0.1:31900/api/alexa-voc/import", { method: "POST", body: JSON.stringify({ asin: "B0T2TASK02", text: "report", autoRebuild: false }) }));
  assert.deepEqual((await response.json() as { detected: string[]; invalid: string[] }).detected, ["顾客关注点", "好评点", "差评点"]);
});
```

- [ ] **Step 3: 运行 RED 测试并确认失败来自缺少 7/7 解析和诊断字段**

Run: `npx tsx --conditions=react-server --test tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts`  
Expected: FAIL；当前真实 fixture 少于 3 维、错误只返回通用字符串，成功体无 `detected`/`invalid`。

- [ ] **Step 4: 在 pipeline 中先计算诊断、后执行唯一的原子提交**

在 `scripts/lib/alexa-voc-pipeline.mjs` 导入 `ALEXA_VOC_DIMENSIONS`，并在 `normalizeAlexaVocSections` 之后计算：

```js
function labelFor(key) {
  return ALEXA_VOC_DIMENSIONS.find(dimension => dimension.key === key)?.label ?? key;
}

function incompleteReportError({ detected, missing, invalid }) {
  const invalidText = invalid.length ? `；无效：${invalid.map(label => `${label}（内容未形成有效条目）`).join("、")}` : "";
  return new Error(`incomplete_report；检测到：${detected.join("、") || "无"}；缺失：${missing.map(labelFor).join("、")}${invalidText}`);
}
```

`processAlexaVocText` 必须返回 `detected`（按 `ALEXA_VOC_DIMENSIONS` 顺序映射 `parsed.detectedKeys`）、`invalid`（检测到但对应 `normalized[key]` 为空的 label）、现有 key 型 `missing`（所有规范化为空的 key）。`saveAlexaVocToSystem` 必须保持调用顺序：`validateAlexaVocReportLimits` → 原始报告 ASIN 校验 → `processAlexaVocText` → `filled < 3` 时 `throw incompleteReportError(processed)` → `commitAlexaVocUpdateSync`。禁止把 `commitAlexaVocUpdateSync` 提前，禁止在错误对象中拼入 `rawText`。

把 `validateAlexaVocReportLimits` 中的表格行统计改为可识别全角竖线、Tab 和 Markdown 行，但不把普通含单个管道符的散文误算为表格：

```js
function isTableRow(line) {
  const text = line.trim();
  return text.includes("｜") || text.includes("\\t") || /^\\|?.+?\\|.+?\\|?$/.test(text);
}
// const tableRows = lines.filter(isTableRow);
```

- [ ] **Step 5: 映射安全 422 并把 UI 限制为服务端诊断展示**

在 `app/api/alexa-voc/import/route.ts` 只从 pipeline 的稳定标签集合重建诊断，禁止把未知错误或报告正文回显：

```ts
const DIAGNOSTIC_LABELS = ["顾客关注点", "好评点", "差评点", "未被满足的需求", "使用人群", "使用场景", "核心购买动机"];

function labelsAfter(code: string, field: "检测到" | "缺失" | "无效") {
  const content = code.match(new RegExp(`${field}：([^；]+)`))?.[1] ?? "";
  return DIAGNOSTIC_LABELS.filter(label => content.includes(label));
}

function incompleteResponse(code: string) {
  const detected = labelsAfter(code, "检测到");
  const missing = labelsAfter(code, "缺失");
  const invalid = labelsAfter(code, "无效");
  const suffix = [`检测到：${detected.join("、") || "无"}`, `缺失：${missing.join("、") || "无"}`];
  if (invalid.length) suffix.push(`无效：${invalid.map(label => `${label}（内容未形成有效条目）`).join("、")}`);
  return Response.json({ error: `Alexa 报告至少需要识别 3 个维度；${suffix.join("；")}`, detected, invalid }, { status: 422 });
}
// catch 中：if (code.startsWith("incomplete_report")) return incompleteResponse(code);
// 成功 JSON 中增加：detected: processed.detected, invalid: processed.invalid。
```

在 `app/alexa-voc-import-panel.tsx` 扩展 payload 类型为 `detected?: string[]; invalid?: string[]`；成功消息追加 `检测到：${payload.detected?.join("、") ?? "无"}` 与无效项，错误只使用 `payload.error`。将说明替换为“可直接粘贴 Alexa 完整回复；支持无序号标题、ASCII/全角括号与复制表格”，placeholder 替换为“粘贴包含目标 ASIN 与七问标题的 Alexa 完整回复…”。不得把解析规则或原始文本放入浏览器日志。

- [ ] **Step 6: 运行 focused 回归并确认所有写入仍在临时目录**

Run: `node --test tests/scripts/parse-alexa-voc-report.test.mjs tests/scripts/normalize-alexa-voc-sections.test.mjs`  
Expected: PASS.

Run: `npx tsx --conditions=react-server --test tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts`  
Expected: PASS；fixture 返回 `filled === 7`，少于三维时仅返回标准维度名，ASIN 不匹配与结构错误前无 cache/projection/state/snapshot 改动。

- [ ] **Step 7: 对本任务变更运行 ESLint 并提交**

Run: `npx eslint scripts/lib/alexa-voc-pipeline.mjs app/api/alexa-voc/import/route.ts app/alexa-voc-import-panel.tsx tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts`  
Expected: PASS with exit code 0.

```bash
git add scripts/lib/alexa-voc-pipeline.mjs app/api/alexa-voc/import/route.ts app/alexa-voc-import-panel.tsx tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts
git commit -m "feat(voc): diagnose real Alexa import compatibility"
```

### Task 4: 全量回归与人工 VSCode 验收准备

**Files:**
- Modify: `tests/scripts/parse-alexa-voc-report.test.mjs`（仅在前面任务遗漏的非敏感断言时补充）
- Modify: `tests/scripts/normalize-alexa-voc-sections.test.mjs`（仅在前面任务遗漏的非敏感断言时补充）
- Modify: `tests/alexa-voc-import-validation.test.ts`（仅在前面任务遗漏的零写入或旧格式断言时补充）
- Modify: `tests/agent/alexa-voc-mutation-routes.test.ts`（仅在前面任务遗漏的无泄漏断言时补充）

**Interfaces:**
- Consumes: Task 1–3 的已提交 parser、normalizer、pipeline、route 与 UI 合同。
- Produces: 可重复的全量验证证据和人工验收清单；如测试无需补充，不创建空提交。

- [ ] **Step 1: 写出并运行跨层 fixture 契约测试**

若尚未由 Task 3 覆盖，在 `tests/alexa-voc-import-validation.test.ts` 增加单个跨层断言；否则跳过编辑，直接运行。断言必须同时锁定 `processAlexaVocText(realFixture, fixtureAsin).ok === true`、`filled === 7`、`missing === []`、`positives` 中有 `好评率 82%`、`negatives` 中有 `差评率 7%`、`attention` 中有 `137次`、`scenarios` 中有全角 `｜`：

```ts
const processed = processAlexaVocText(realFixture, fixtureAsin, { worktree });
assert.equal(processed.ok, true);
assert.equal(processed.filled, 7);
assert.deepEqual(processed.missing, []);
assert.match(processed.sections.positives.join("\n"), /好评率 82%/);
assert.match(processed.sections.negatives.join("\n"), /差评率 7%/);
assert.match(processed.sections.attention.join("\n"), /137次/);
assert.match(processed.sections.scenarios.join("\n"), /｜/);
```

- [ ] **Step 2: 运行所有兼容性 focused 测试**

Run: `node --test tests/scripts/parse-alexa-voc-report.test.mjs tests/scripts/normalize-alexa-voc-sections.test.mjs`  
Expected: PASS.

Run: `npx tsx --conditions=react-server --test tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts`  
Expected: PASS.

- [ ] **Step 3: 运行既有发布相关回归，不触发真实发布**

Run: `node --test tests/scripts/alexa-publication-state.test.mjs tests/scripts/alexa-publication-transaction.test.mjs tests/scripts/alexa-publication-worker.test.mjs tests/scripts/alexa-capture-publication.test.mjs`  
Expected: PASS；测试只操作临时 fixture/worktree，不创建真实 reload 请求或服务进程。

- [ ] **Step 4: 执行 changed-file ESLint 和完整构建/渲染验证**

Run: `npx eslint scripts/lib/parse-alexa-voc-report.mjs scripts/lib/normalize-alexa-voc-sections.mjs scripts/lib/alexa-voc-pipeline.mjs app/api/alexa-voc/import/route.ts app/alexa-voc-import-panel.tsx tests/scripts/parse-alexa-voc-report.test.mjs tests/scripts/normalize-alexa-voc-sections.test.mjs tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts`  
Expected: PASS with exit code 0.

Run: `npm test`  
Expected: PASS；构建成功且 `tests/rendered-html.test.mjs` 通过。若失败，记录完整命令和失败归属；不得通过修改无关用户 WIP 或关闭检查来掩盖失败。

- [ ] **Step 5: 记录全仓 lint 基线，不混淆为本次结果**

Run: `npm run lint`  
Expected: 记录 exit code 和输出；若已有全仓基线错误，确认本任务 changed-file ESLint 已通过，并只报告基线问题，不修改无关文件。

- [ ] **Step 6: 检查提交范围与人工验收前置条件**

Run: `git status --short`  
Expected: 仅存在实施前已有用户 WIP 与（如 Task 4 新增）上述测试文件；不存在 fixture 中真实品牌、真实 ASIN、真实价格、完整评论或密钥。

人工验收仅在用户主动用 VSCode 启动正式系统后执行；验收者选择与报告内 ASIN 一致的条目，原样粘贴实际 Alexa 完整回复，预期页面显示“已识别 7 / 7 维”和既有后台正式页面发布状态。用报告内不同 ASIN 重试，预期 422 且页面内容、cache、投影与发布状态不变。执行此计划的代理不得自行启动、停止或重载该服务。

- [ ] **Step 7: 仅在 Task 4 确实编辑测试时提交**

若 Step 1 为补漏而编辑了测试：

```bash
git add tests/scripts/parse-alexa-voc-report.test.mjs tests/scripts/normalize-alexa-voc-sections.test.mjs tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts
git commit -m "test(voc): verify real Alexa import regression"
```

若 Step 1 未编辑文件，执行 `git status --short` 证明无需空提交。

## Self-Review

- **Spec coverage:** Task 1 覆盖七个标题、ASIN 首部、section 边界、重复/总结隔离、保持列/纵向/编号三种结构；Task 2 覆盖好评率、差评率、提及次数、Q&A、星级、未知值、列不借位和旧格式；Task 3 覆盖先校验后原子提交、3 维门槛、422/成功诊断、鉴权后读取的现有路由和 UI 引导；Task 4 覆盖 focused、发布回归、ESLint、构建、lint 基线和 VSCode 人工验收。非目标（无 LLM/网络/父体替代/发布协议修改）已列入 Global Constraints。
- **Placeholder scan:** 未发现禁用占位词、延后实现措辞、跨任务引用或未定义的泛化错误处理步骤；每个代码步骤给出文件、函数/数据形状、命令与期望结果。
- **Type consistency:** Task 1 的 `ALEXA_VOC_DIMENSIONS`、`ParsedSectionRecord`、`detectedKeys` 被 Task 2/3 使用；Task 2 继续输出 `Record<string, string[]>`；Task 3 保留 `missing: string[]` 并新增 label 型 `detected`/`invalid`，路由与 UI 按该定义消费。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-30-alexa-real-report-compatibility.md`. Execute it with subagent-driven development: one fresh implementer per task, independent review after each task, and no service/provider interaction.
