# 美国、英国、德国、加拿大统一候选验收

用户将适配范围明确为 US、UK、DE、CA 四站；沿用已实施的统一项目、采集、冻结证据与分析链路。候选为 33900/33901，正式 31900/31901 与原候选 32900/32901 保持原进程和代码。本次新增美国完整清单与英国独立代表样本的真实链路验证，保存原英国飞镖完整清单的失败/缺数记录，并保留德国、加拿大此前的报告身份。

## 四站契约

| 站点 | 项目标识 | Sorftime 标识 | 币种 | VOC 输入 |
|---|---|---|---|---|
| 美国 | US | US | USD | 已有手工 Alexa；显式选择时允许本站评论补充 |
| 英国 | UK | GB | GBP | 显式本站评论兜底 |
| 德国 | DE | DE | EUR | 显式本站评论兜底 |
| 加拿大 | CA | CA | CAD | 显式本站评论兜底 |

所有站点均保留组织、项目、站点、ASIN、采集运行、证据哈希与报告身份。手工 Alexa 仓库仍是美国已有能力；非美国站不得访问或冒充美国手工材料。上游缺失、连接失败和部分覆盖保持原状。非美国站完整规范化流量分析仍有既有支持边界，原始流量采集完成不能代表所有流量指标完整。

## 验证范围和方法

- 共享项目接口已有四站枚举。补充英国采集缓存隔离、Sorftime UK → GB 请求及缓存键、GBP 目录、英国冻结证据和跨站拒绝回归；增加四站币种对照断言。
- 定向契约回归 42/42 通过，日志位于独立运行目录 `evidence/four-market-contract-tests.log`。
- 四站 SQLite/PostgreSQL 冻结输入、重复请求与事务回滚回归 8/8 通过（`four-market-atomicity-tests.log`）；包含 USD/GBP/EUR/CAD 的报告页面回归 6/6 通过（`four-market-ui-currency-tests.log`）。类型检查通过（`four-market-typecheck.log`）。本轮共 56 项定向测试，没有把此前完整历史套件中的既有失败声称为已修复。
- 美国使用已克隆平衡板项目的完整 9 个 ASIN，英国首先使用已克隆飞镖套装项目的完整 7 个 ASIN。来源清单位于 `four-market-cloned-project-sources.json`；只复用商品身份，不借用其他组织或站点的分析材料。
- 美国已通过公开接口新建项目、真实采集及两阶段模型分析。实际浏览器验证发现美国旧页面仍优先显示等待手工 VOC，未将已保存的固定来源产品报告呈现为当前结果；已修复该显示路径，保留手工与本地规则入口。
- 英国原 7-ASIN 飞镖队列终结但数据不齐，关键词 0/7、评论 1/7、销售趋势 1/7，目录 5/7；没有强行提交分析。Sorftime 实时工具契约确认 `GB`，SIF 实时契约确认 `UK`。针对原商品 `B0DLB22T15` 的受治理销售趋势探针仍返回真实工具错误，不能将其解释成空数据或放宽熔断。
- 英国另建平衡板代表样本，使用实时 `product_search_from_name` 的 GB 搜索 `balance board` 结果中，小类 `458414031` 的前 3 个商品：`B07DWKNXNY`、`B00WJJJX2Q`、`B09KCRFK3D`。选择依据是品类，不是采集成功率。该独立项目用于验证英国站链路，不能替代或覆盖原飞镖项目的缺口。
- 德国和加拿大此前已完成真实创建、采集、两阶段模型分析、四份报告保存及公开接口同键重放。详细边界见 [德国和加拿大验收记录](2026-10-21-de-ca-candidate-acceptance.md)。

运行根目录：`C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/de-ca-analysis-20261021`。美国和英国状态单独保存在 `evidence/us-uk-live-run-state.json`，不覆盖德国和加拿大的 `live-run-state.json`。

本轮开始时运行代码为 `5ed7f4df8eeaaef80ba820ce45b4966d4ede017f`，sourceHash 为 `f906100c71a1a7b3986180f5ecb0c8696e81eba6fbedc1787a15ad02a5ce43e8`。最终美国页面修复已重新构建，运行身份见下方。

英国原飞镖证据保存在 `UK-darts-run-state.json`、`UK-darts-admission.json`、`UK-darts-collection.json`、`UK-darts-inventory.json`、`UK-darts-source-diagnostics.json`。原项目 `6fb02de8-60dd-4c87-b168-8bbcb3cce277`、任务 `fcbd86a0-501c-42b2-b28d-6f7d851db03b` 与 7 个 ASIN 均保留。新平衡板项目 `1e48ae2c-2970-4507-b923-7600034e1065`、任务 `9ded3f32-5f37-486b-a7f5-c7d7f4dbe3e5` 使用独立身份。

## 四站真实执行结果

| 站点 | 商品数 | 真实分析运行 ID | VOC / 新品定义 | 评论覆盖 |
|---|---:|---|---|---|
| 美国 | 9 | `705a710d-a315-48b0-a7e2-3914440b1851` | 均 succeeded，各保存 v1 partial 报告 | 7/9；2 个上游无结果 |
| 英国代表样本 | 3 | `30445819-3166-4b80-8743-9f425cca68a3` | 均 succeeded，各保存 v1 partial 报告 | 3/3，维度仍非全覆盖 |
| 德国 | 5 | `485ff5cc-5828-45d2-a020-307bbab2dd03` | 均 succeeded，各保存 v1 partial 报告 | 2/5；3 个连接失败 |
| 加拿大 | 3 | `4cb657d2-6376-4c80-8259-8ace35a0c5f0` | 均 succeeded，各保存 v1 partial 报告 | 2/3；1 个上游无结果 |

美国目录采集阶段接收 9/9 结果，但页面仍有 5 个 ASIN 的目录字段未验证（上游空值），不能把阶段终结当作目录字段完整。关键词、销量趋势、价格、Listing、类目、原始流量各 9/9；子体销量与 FBA 各 7/9；图片 55/55 就绪。美国本次候选组织未导入手工 Alexa，真实执行使用显式评论兜底；原手工流程由回归覆盖，不能把它说成本轮真实手工导入验收。

英国平衡板样本目录、关键词、评论、销量趋势、子体销量、价格、Listing、类目、原始流量各 3/3；FBA 2/3（1 个上游无结果），图片处理 19/19、就绪 17、连接失败 2。原飞镖 7-ASIN 项目仍不具备分析输入，未生成报告，不能用平衡板成功代表飞镖项目完成。

美国和英国本轮通过公开 HTTP 逐站核对两个阶段成功、两份报告存在，并使用相同请求体和幂等键重放，均返回原运行 ID；德国与加拿大保留此前已通过的相同验证。`four-market-acceptance-summary.json` 核对四站完整选区、站点、项目、基础采集运行和报告身份。

`four-market-model-audit.json` 确认四站 8 个通过的真实模型阶段均有响应 ID 及非零输入/输出 token，模型为 `gpt-5.6`；`four-market-model-budget-audit.json` 保留预算结算。用量汇总包含当前运行内的历史失败尝试，不是仅 8 次成功调用的用量。`four-market-relay-normalization-audit.json` 核对候选兼容事件仍与真实预算响应哈希关联。

## 美国报告回显修复与页面验收

`531a7f59` 接入只读固定来源报告展示：显式 `vocRun` 的组织、项目、US 站点、基础运行、商品范围及产品报告 manifest 校验通过后，将已保存产品报告作为主要结果。`savedRunOnly` 禁止自动登记和模型提交；无 `vocRun` 以及仅有 `vocHistory` 时保留原流程。

独立审查发现显式 `vocAsins` 被 manifest 选区覆盖、手工 VOC 更新未刷新指纹两项 P2。`4bf06b02` 修复后复审通过：显式选区进入 owner，未指定选区才恢复 manifest；手工来源的 revision/contentHash 进入刷新标识，使旧 inventory 在重新读取前立即失效。

专项浏览器回归先得到 3 通过、2 个预期失败，修复后 5/5 通过，日志为 `us-ui-scope-fix-red.log` 和 `us-ui-scope-fix-browser.log`。手工更新测试模拟版本刷新参数变化，不是一次真实手工导入；`onImported → importSucceeded → effectiveVocByAsin → refreshToken → inventoryOwner` 的真实连接通过代码复核。最终类型检查退出码 0 保存在 `four-market-final-typecheck-result.json`，提交为 `4bf06b02`；稳定构建退出码 0，日志为 `four-market-final-build.log`。

早期并发组合曾得到 21/26 通过、5 项失败，不能只凭推测归因于环境。最终提交采用正确的浏览器运行条件串行重跑完整相同文件范围：`npx tsx --test --test-concurrency=1 tests/agent/voc-local-rules.test.tsx tests/agent/voc-keyword-evidence-browser.test.ts tests/agent/voc-automation-browser.test.ts`，32/32 通过、退出码 0（之前模块加载失败的本地规则现在逐条执行，因此计数不同）。证据为 `four-market-final-browser-regression.log` 与 `four-market-final-browser-regression-result.json`。连同四站契约 56 项和美国专项 5 项，本轮最终适用的定向回归共 93 项通过；这不代表前一轮已明确保留的完整历史套件 6 项既有失败被修复。

最终候选实际浏览器四页均显示“当前结果已保存”，分别显示 US 7/9、UK 3/3、DE 2/5、CA 2/3 评论覆盖。证据为 `US/UK/DE/CA-final-ui.txt`。美国实际从 9 个商品取消 1 个后，当前报告标记消失；刷新恢复完整 9 个后原报告重新成为当前结果（`US-selection-changed-ui.txt`、`US-restored-ui.txt`）。美国已保存 VOC 展开后可读取摘要（`US-voc-ui.txt`）。最终截图为 `US-definition.jpg`、`UK-definition.jpg`；德国和加拿大之前的截图及本轮最终页面文本共同保留。

重启最终候选后再次执行四站公开接口核对与同键重放，均通过；日志为 `de-ca-final-public-verification.log`、`us-uk-final-public-verification.log`。没有重新消耗模型额度来验证纯页面修改。

## 最终候选身份与隔离

| 服务 | 端口 | PID | 源码提交 |
|---|---:|---:|---|
| 候选 Web | 33900 | 314832 | `4bf06b0286a5e29995a2d4241c714cc986802add` |
| 候选 Agent | 33901 | 330104 | `4bf06b0286a5e29995a2d4241c714cc986802add` |

二者 sourceHash 均为 `309aaaa9407ae3df9e464c3fd35162913243a118be6a5a01ec2e4fbde81e483e`。数据库仍为隔离的 `amazon_de_ca_formalbase_20261021`。重启前确认候选活动采集任务 0、活动分析任务 0。

`four-market-baseline-before.json` / `four-market-baseline-after.json` 验证正式 31900/31901 和原候选 32900/32901 的 PID、提交和源码指纹全部未变。其 PID 分别为 31676、69464、280340、217620。没有合并、推送或正式发布；33900/33901 保留供用户验收。

## 页面入口

- [美国 9 个 ASIN](http://192.168.1.109:33900/p/four-market-us-candidate-us?tab=definition&vocRun=705a710d-a315-48b0-a7e2-3914440b1851&run=f49a7894-1af4-45e6-8994-8bbbeab477b7&syncJob=b5b423c8-04f6-4988-981f-a678c4294df8)
- [英国代表样本 3 个 ASIN](http://192.168.1.109:33900/p/four-market-uk-balance-boards-candidate-uk?tab=definition&vocRun=30445819-3166-4b80-8743-9f425cca68a3&run=cd4ad251-1c02-415e-897b-d157e3cd96a5&syncJob=9ded3f32-5f37-486b-a7f5-c7d7f4dbe3e5)
- [德国 5 个 ASIN](http://192.168.1.109:33900/p/playground-fitness-equipment-de?tab=definition&vocRun=485ff5cc-5828-45d2-a020-307bbab2dd03&run=da1910f4-9612-456a-96c8-70fe627c2500&syncJob=57a01914-3d98-4786-9364-b52991fd572d)
- [加拿大 3 个 ASIN](http://192.168.1.109:33900/p/balance-boards-ca-candidate-ca?tab=definition&vocRun=4cb657d2-6376-4c80-8259-8ace35a0c5f0&run=2b8034c5-986e-4fbb-9387-1060cc16282d&syncJob=299ad89b-49e1-4211-b739-bf82d34242be)

上述四页已在当前内置浏览器候选登录会话中打开并保留。报告均是有证据边界的部分覆盖结果，不能视为立项批准或全部上游数据完整。原英国飞镖项目未达到分析输入条件，仍需针对原商品补数据；该限制不会被独立代表样本的通过覆盖。
