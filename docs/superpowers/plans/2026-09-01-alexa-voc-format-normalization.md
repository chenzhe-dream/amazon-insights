# Alexa VOC Format Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept Alexa seven-question reports that use emoji plus `#1`–`#7` display headings, normalize them into the existing seven VOC dimensions, and continue rejecting unrelated prose.

**Architecture:** Keep the existing parser and normalized VOC contract. Extend only the deterministic heading-prefix recognizer so presentation markers are removed before exact dimension-alias matching; verify the behavior at both parser and manual-import service boundaries.

**Tech Stack:** Node.js 22+, ECMAScript modules, TypeScript, `node:test`, existing manual Alexa VOC service.

## Global Constraints

- 运营人员可以直接粘贴 Alexa for Shopping 生成的七问报告，不需要手工删除 emoji、编号、Markdown 标记或括号说明。
- 归一化后仍只接受现有七个标准维度及既有明确别名。
- 继续要求所选 ASIN 的绑定合同与至少三个有效标准维度。
- 无关文本、空段落、超限内容和不同 ASIN 仍然失败关闭。
- 不使用模糊关键词或 AI 猜测把任意文章映射成 VOC。
- 不改变数据库结构、导入原子性、Provider、任务生命周期或前端提交次数。
- 不新增维度或 ASIN 特例。
- 不部署、不调用 Provider、不替用户点击导入。

---

### Task 1: Normalize Alexa display prefixes without weakening the VOC contract

**Files:**
- Modify: `tests/scripts/parse-alexa-voc-report.test.mjs:23-32`
- Modify: `tests/agent/manual-alexa-voc-service.test.ts:314-328`
- Modify: `scripts/lib/parse-alexa-voc-report.mjs:19`

**Interfaces:**
- Consumes: `parseAlexaVocReport(rawText: string, asinHint?: string)` and `ManualAlexaVocService.importReport(...)`.
- Produces: the same parser and service return contracts; only accepted presentation-prefix syntax expands.

- [ ] **Step 1: Add parser RED cases for real Alexa headings and unrelated prose**

Append this test to `tests/scripts/parse-alexa-voc-report.test.mjs`:

```js
test("normalizes Alexa hash-numbered display headings without accepting arbitrary prose", () => {
  const parsed = parseAlexaVocReport([
    "🎯 #1 顾客关注点 (客户最在乎什么)", "1. 颜色准确",
    "✅ # 2 好评点 (为什么给5星)", "1. 质量可靠",
    "❌ ＃3 差评点 (为什么给1-2星)", "1. 包装破损",
    "💭 4 未被满足的需求 (顾客想要但没有的)", "1. 更多颜色",
    "👥 5️⃣ 使用人群 (谁在买)", "1. 家庭用户",
    "## 使用场景：", "1. 卧室",
    "⚡ #7 核心购买动机 (为什么最终决定买)", "1. 性价比",
  ].join("\n"));
  assert.deepEqual(parsed.detectedKeys, keys);
  assert.deepEqual(parsed.missing, []);

  const unrelated = parseAlexaVocReport("这是一段讨论顾客关注点、好评点和购买动机的普通产品介绍。");
  assert.deepEqual(unrelated.detectedKeys, []);
});
```

- [ ] **Step 2: Run the parser test and verify RED**

Run:

```powershell
node --test tests/scripts/parse-alexa-voc-report.test.mjs
```

Expected: the new test fails because `#1`/`# 2`/`＃3` after emoji are not removed and `detectedKeys` is incomplete.

- [ ] **Step 3: Add a service-boundary RED for the pasted report shape**

Append this test to `tests/agent/manual-alexa-voc-service.test.ts`:

```ts
test("imports an Alexa report with emoji hash-numbered headings", async () => {
  const harness = successfulHarness();
  const rawText = [
    "🎯 #1 顾客关注点 (客户最在乎什么)", "1. 颜色准确",
    "✅ #2 好评点 (为什么给5星)", "1. 质量可靠",
    "❌ #3 差评点 (为什么给1-2星)", "1. 包装破损",
    "💭 #4 未被满足的需求 (顾客想要但没有的)", "1. 更多颜色",
    "👥 #5 使用人群 (谁在买)", "1. 家庭用户",
    "🏠 #6 使用场景 (什么时候用)", "1. 卧室",
    "⚡ #7 核心购买动机 (为什么最终决定买)", "1. 性价比",
  ].join("\n");

  const response = await harness.service.importReport({
    principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
    request: { asin: ASIN, marketplace: "US", rawText },
  });

  assert.equal(response.record.asin, ASIN);
  for (const key of ["attention", "positives", "negatives", "unmet", "audiences", "scenarios", "motives"] as const) {
    assert.ok(response.record.normalizedRecord[key].length > 0, key);
  }
  assert.equal(harness.transactionCalls(), 1);
});
```

- [ ] **Step 4: Run the service test and verify RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-service.test.ts
```

Expected: the new test rejects with `ManualAlexaVocServiceError` kind `incomplete`, before any transaction.

- [ ] **Step 5: Implement the minimal deterministic prefix normalization**

Replace `HEADING_PREFIX` in `scripts/lib/parse-alexa-voc-report.mjs` with:

```js
const HEADING_PREFIX = /^(?:#{1,6}\s*)?(?:(?:\p{Extended_Pictographic}|\uFE0F|\u20E3|\u200D)+\s*)?(?:(?:[#＃]\s*)?(?:[1-7]️⃣|[1-7])\s*[.、)）:：\-—]?\s*)?/u;
```

This strips only bounded 1–7 presentation numbering. Exact alias matching and `HEADING_SUFFIX` remain unchanged.

- [ ] **Step 6: Run focused GREEN tests**

Run:

```powershell
node --test tests/scripts/parse-alexa-voc-report.test.mjs
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-service.test.ts
```

Expected: both suites pass with no new warnings.

- [ ] **Step 7: Verify the user's attached text locally without importing it**

Run:

```powershell
$env:VOC_INPUT_FILE='C:\Users\EDY\.codex\attachments\a2b56eff-a9dc-4da4-b8cb-a194e55e29d7\pasted-text.txt'
@'
import fs from "node:fs";
import { processAlexaVocText } from "./scripts/lib/alexa-voc-processing.mjs";
const result = processAlexaVocText(fs.readFileSync(process.env.VOC_INPUT_FILE, "utf8"), "B0CSYXYWDZ", { bindAsinHint: true, reviewCount: 0, rating: 0 });
console.log(JSON.stringify({ filled: result.filled, detected: result.detected, missing: result.missing }));
'@ | node --input-type=module -
```

Expected: `filled` is `7`, all seven labels are present in `detected`, and `missing` is empty. This command performs no HTTP request and no database write.

- [ ] **Step 8: Run affected regression, lint, and build**

Run:

```powershell
node --test tests/scripts/parse-alexa-voc-report.test.mjs tests/scripts/normalize-alexa-voc-sections.test.mjs
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-service.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts
npx eslint scripts/lib/parse-alexa-voc-report.mjs tests/scripts/parse-alexa-voc-report.test.mjs tests/agent/manual-alexa-voc-service.test.ts
npm run build
git diff --check
```

Expected: all focused tests pass, ESLint exits 0, production build succeeds, and diff check reports no errors.

- [ ] **Step 9: Commit only the parser and tests**

```powershell
git add -- scripts/lib/parse-alexa-voc-report.mjs tests/scripts/parse-alexa-voc-report.test.mjs tests/agent/manual-alexa-voc-service.test.ts
git diff --cached --check
git commit -m "fix: normalize Alexa VOC heading prefixes"
```

Expected: the commit contains exactly those three files; protected generated application data remains unstaged.
