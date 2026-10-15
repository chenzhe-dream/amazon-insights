# 四模块离线流程与站点语言验证（2026-10-14）

## 范围与环境

按用户要求，在 MCP 无额度期间优先验证流程稳定性，采用虚拟供应商、虚拟模型和临时 PostgreSQL。候选代码位于 `market-research-favorites-v2/feat-voc-positioning-skill-execution`，基于 HEAD `253366e8` 加当前未提交修改。

本次没有触发真实 MCP 或真实模型请求，没有向 32900/31900 数据库填充虚拟记录，没有启动新的真实采集，也没有重建或发布 Web/Agent。现有 32900 服务仍使用原运行配置，不能把它当作离线虚拟环境点击采集。

## 实现变更

1. 翻译目标取已保存报告的站点，不取页面当前草稿站点；美国 en-US、英国 en-GB、加拿大 en-CA、德国 de-DE、法国 fr-FR、意大利 it-IT、西班牙 es-ES、日本 ja-JP。加拿大本次默认英语。
2. 缓存版本升级为 v2，目标语言进入哈希；旧 v1 中文缓存保留但不作为其他语言结果复用。原文、报告身份、模型身份和目标语言共同决定缓存。
3. 翻译请求明确携带目标语言，保留数字、否定、条件、品牌；失败返回原文，可重试，读取和刷新不触发翻译。字符与数字校验是基本校验，不能证明翻译语义质量。
4. 页面统一翻译按钮按报告显示目标语言，移除主题表中固定中文的本地替换，已译摘要可展开查看原文。界面导航和操作提示仍为中文。
5. 新增多类目离线联动回归：US 3405881，DE 990000002，JP 990000003。后两项为虚拟类目，不是可供真实采集的亚马逊节点。断言 12 个模块任务的国家、币种、类目、月份正确；重复提交不重复建任务，旧批次恢复不串数据。

统一翻译目前沿用显式按钮触发；选择国家决定目标语言，不会因切换页面或读取历史自动产生模型费用。未设置新的语言选择器。数据仍为 Amazon Customers Say 主题及摘要，不冒充逐条评论，也不把翻译当作该国家的真实采样证明。

## 本轮证据

- 最终后端组合：12 个测试文件，97/97，通过（含多类目、四模块规则流程、联动 HTTP/幂等/权限、取消、采集器超时/限流/非法数据、翻译）。
- 最后追加翻译配额失败、数字篡改、重复提交、错误报告身份：翻译 2 文件重跑 5/5，通过，与上项有重叠，不相加。
- 界面静态渲染：`market-theme-original-ui.test.tsx` 与 `market-theme-ui-parity.test.tsx` 共 16/16，通过；覆盖德国译文/原文/失败回退和按钮目标语言。
- 额外完整链路：总览持久化及运行时重建 1 项，形态有/无模型配置 2 项，评论完整流程及图片失败、混合无效来源、空类目 4 项，通过。总览模型响应完全合成，日志记录 26 次虚拟来源调用、4 次虚拟模型调用。
- TypeScript：`node node_modules/typescript/bin/tsc --noEmit --incremental false` 通过（最后结果以本轮工具退出码为准）。
- `git diff --check` 通过。
- 浏览器连接：Chrome/Edge inventory 返回 `nodeRepl.fetch request failed`；内置浏览器绑定现有 3405881 报告页在 30 秒超时、kernel reset。未获得新代码的浏览器验收证据。

后端组合命令（PowerShell，临时数据库需 Docker）：

```powershell
$env:NODE_OPTIONS='--conditions=react-server'
node --import tsx --test tests/agent/market-linked-multicategory-offline.test.ts tests/agent/market-four-module-rules-integration.test.ts tests/agent/market-linked-analysis.test.ts tests/agent/market-linked-http.test.ts tests/agent/market-theme-translation.test.ts tests/agent/market-theme-translation-contracts.test.ts tests/agent/market-theme-source-failure.test.ts tests/agent/market-cancellation.test.ts tests/agent/market-keyword-read-recovery.test.ts tests/agent/market-keyword-flow.test.ts tests/agent/market-customer-themes-collector.test.ts tests/agent/market-keyword-collector.test.ts
```

UI 静态渲染测试需在不带 `react-server` 条件的进程运行。

## 后续验收顺序

1. 准备独立可浏览的虚拟测试运行环境：独立数据库与翻译缓存、显式“虚拟数据”标识，供应商与翻译均使用固定响应；未知操作直接失败，禁止回落到真实连接器。保留正常登录与权限校验。
2. 浏览器验证总览输入→四模块自动同步→切换→刷新恢复→定向重试→取消；组合成功、空数据、限流、超时、部分失败场景，记录任务数不因刷新增长。
3. 使用德语、日语与英语的混合原文固定样本，验证统一翻译按钮、原文展开、失败项重试、缓存和旧报告目标语言。模拟译文只证明流程，不作为语言质量验收。
4. 候选浏览器验收通过后再安排 31900 更新；恢复真实额度后补做真实供应商和翻译质量验收。

以上 1–4 尚未完成；不得把离线回归等同于正式全链、供应商返回质量或真实翻译质量验收。现有 OpenSpec 的真实验收/发布事项保持未完成。

## 后续补充：大模型与内容缓存（2026-10-14）

用户在 Argos 离线试验后确定继续采用大模型翻译，保留持久化缓存及固定词条。候选实现增加 v3 报告状态和独立的内容缓存，相同文本可跨报告复用；10 个登记主题词按报告目标语言直接返回，长文本不做词语替换。前述“移除固定中文替换”仍成立，此次词条支持各站点语言而非一律翻成中文。详见 `llm-translation-cache-plan-20261014.md`。本次仍未发布，真实模型与浏览器验收状态不变。
