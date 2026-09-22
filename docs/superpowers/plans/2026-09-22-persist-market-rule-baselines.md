# 把四个模块的规则基线写入现有任务 — 实施计划

日期：2026-09-22  
工作树：`C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\market-main-20260921`  
分支：`codex/market-main-20260921`  
当前代码：`77059278`（四个模块的规则基线函数已在本地，尚未写入任务）  
OpenSpec：`openspec/changes/split-market-rule-baselines/` 第 3 节

## 这份计划和 OpenSpec 的关系

OpenSpec 的作用不是重建四模块框架，也不是改页面。框架、采集步骤、租约和页面已经在跑。本地 TypeScript 规则也已经能算出数字。本计划只执行第 3 节：来源成功后、语义步骤前，把已有规则基线保存进任务记录。

卖家精灵采集和模型调用保持可用。基线是多出来的一份任务输出，不替换来源步骤，也不取消后面的语义步骤。有组织凭据时，卖家精灵仍按现有来源步骤请求；模型仍按现有窗口、批次和综合步骤调用。模型没配、超时或校验失败时，已保存的基线仍可读，语义状态另记。

| OpenSpec | 本计划 |
|---|---|
| 第 1、2 节 规则基线函数 | 已完成，本计划不重写计算器 |
| 第 3 节 持久化与重放 | **本计划的全部范围** |
| 第 4 节 Agent 只读边界 | 不做 |
| 第 5 节 验收文档与正式发布 | 不做。不重启、不发布 31900/31901 |

写入之后，模型超时或校验失败时，任务里仍能读到规则基线，语义状态另记。同一条已接受命令重放时，不重新采集、不调用模型。历史报告和页面等待框保持原样。

## 回滚点

实施前的代码是 `77059278`。本计划获准并开始改代码后，每一模块单独提交。不要 `reset --hard`，不要回到 `main`。

## 不做

- 不把新建任务改成「规则完成即结束」。卖家精灵来源步骤和模型步骤仍按现有 flow 调度，并且必须能实际执行。
- 不改公开报告 JSON 的既有字段，不改页面。
- 不把图片、毛利、退货、推荐竞价、完整 PVS、逐条评论补成已有值。
- 不执行第 4、5 节，不跑 `manage-formal-stack.ps1`。

## 写入位置

规则基线写在**该模块语义步骤之前、已经会成功落库的那一步输出**里，字段名 `ruleBaseline`。不新增一种会挡住旧 flow 的必经步骤。

历史输出没有这个字段。冻结重放时，若已保存输出不含 `ruleBaseline`，重算结果也不得带上它，避免 `digest(已保存输出)` 和 `digest(重算输出)` 不一致。新执行才写入。

| 模块 | 写入点 | 使用的已有函数 | 语义步骤仍在其后 |
|---|---|---|---|
| 市场总览 | 目录步骤 `overview-source-catalog` 的输出。这一步已经在窗口和综合之前 | `buildOverviewRuleBaseline` | `overview-windows`、模型批次、synthesis |
| 商品形态及价格带 | 商品池投影步骤的输出，在 `prepare-model-batches` 之前 | `buildShapePriceRuleBaseline` | 形态建议与解释 |
| 类目关键词洞察 | 趋势池准备完成的输出，在 `prepare-model-batches` 之前 | `buildKeywordRuleBaseline` | 语义归类与 reconciliation |
| 类目买家评论见解 | Customers Say 样本池步骤的输出，在主题映射模型之前 | `buildCustomerThemeRuleBaseline` | 现有 `customer-theme-rules` 仍在模型之后，负责语义映射，不替代这份计数基线 |

关键词在模型归类之前只能写入搜索量、日历增长和缺失项。簇标签若还没有人工修订，覆盖保持缺失，不为了等模型而推迟基线。主题基线按冻结样本计数；排除或恢复样本时从原池重算，不重新采集。

## 实施顺序

### 1. 总览

**文件**

- `server/runtime/market-overview-catalog-step.ts`
- `server/domain/market-research/overview-rule-baseline.ts`（只调用，不改算法）
- 测试 `tests/agent/market-rule-baseline-runtime.test.ts`

**做法：** 新目录执行把 `ruleBaseline` 放进步骤输出。冻结读取发现旧输出没有该字段时，重算也不加。模型窗口失败不删除已保存的目录输出。

**完成：** 隔离测试里，目录成功后能读到基线；随后的模型失败不改变这份基线；旧输出摘要不变。提交：`feat: persist overview rule baseline before semantic steps`

### 2. 形态

**文件：** 形态投影步骤的运行时处理，以及 `shape-price-rule-baseline.ts`。

**做法：** 投影成功时写入价格带、销量、修订号，以及图片、毛利、退货的缺失原因。不改后续模型批次的调度。

**完成：** 提交：`feat: persist shape rule baseline before semantic steps`

### 3. 关键词

**文件：** 关键词趋势池步骤的运行时处理，以及 `keyword-rule-baseline.ts`。

**做法：** 写入搜索量和 `calendar-three-month-growth/v1`。`cpc` 保持缺失，原因仍是只有推荐竞价。季节性保持 unavailable。

**完成：** 提交：`feat: persist keyword rule baseline before semantic steps`

### 4. 主题

**文件：** 主题样本池步骤的运行时处理，以及 `customer-theme-rule-baseline.ts`。

**做法：** 写入提及、正、负和 `not_assumed_disjoint`。`uniqueReviews` 保持缺失。样本排除只重算这份基线。

**完成：** 提交：`feat: persist theme rule baseline before semantic steps`

## 测试，不碰正式服务

每一模块用现有的临时 PostgreSQL：Docker 里的测试库，`CREATE SCHEMA` 后把 `search_path` 指到该 schema。不连接正式库的 `public`，不绑定、不重启 31900/31901。

隔离测试使用现有的卖家精灵连接器替身和模型客户端替身，用来证明这两条路径仍然会被调用。不拿正式环境的真实凭据去打正式服务。

每个模块至少断言：

1. 来源或池步骤成功后，输出里有一份 `ruleBaseline`，并且卖家精灵来源步骤已经执行。
2. 后续模型步骤仍会被调度。模型失败、未配置或超时后，这份基线仍在，语义状态分开。
3. 重放同一已接受命令时，不再增加采集调用和模型调用。
4. 没有 `ruleBaseline` 的历史输出，重算摘要与当初保存的一致。

## 审核通过后才做

按 1 到 4 的顺序改代码。第 4 节 Agent 边界和第 5 节验收文档不在这次执行里。测试通过后停下来，等你看隔离结果，再决定要不要发布正式服务。
