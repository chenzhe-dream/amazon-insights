# 德国站与加拿大站候选验收记录

状态：两站均通过候选链路验收。已验证任务创建、真实采集、固定证据、真实 VOC 与新品定义、四份报告保存和页面读取，以及公开创建接口同键重放。报告保留部分覆盖与待验证边界，未切换正式环境。

## 环境与范围

- 基线：正式源 `7efbc72a25f105192ec7786769b7d30a205fb3ae`。
- 分支：`codex/de-ca-analysis-candidate-20261021`。
- 代码：`C:/Users/EDY/.codex/worktrees/de-ca-analysis-candidate/feat-voc-positioning-skill-execution`。
- 独立候选：Web 33900 / Agent 33901。
- 独立数据库：`amazon_de_ca_formalbase_20261021`，从正式库只读导出后恢复到候选 PostgreSQL 容器。
- 数据、运行目录、Cookie 命名空间均独立。正式 31900/31901 与原候选 32900/32901 的 PID、commit、sourceHash 已逐项确认前后相同。
- 实际运行代码：`5ed7f4df8eeaaef80ba820ce45b4966d4ede017f`；两服务 sourceHash 均为 `f906100c71a1a7b3986180f5ecb0c8696e81eba6fbedc1787a15ad02a5ce43e8`，与构建一致。Web PID `326508`，Agent PID `321784`。后续仅提交本验收文档，不改变运行代码。
- 真实模型：`gpt-5.6`，`relay-chat-json`，`AGENT_VOC_LOCAL_FAKE=0`；使用真实供应商数据，未填造缺口。
- 本次链路：项目注册 → 站点限定采集 → 固定证据版本 → VOC → VOC 与关键词交叉新品定义 → 保存报告 → 刷新读取。

运行目录：`C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/de-ca-analysis-20261021`。启动器、验收账户文件和私有诊断留在该目录，不进入 Git。现有候选浏览器会话已经登录；其他浏览器可使用库克隆时已有的账户登录候选地址。

## 任务与报告身份

| 项目 | 德国 DE | 加拿大 CA |
|---|---|---|
| 项目 ID | `0e6d9225-54b4-404f-b998-44a53f3f1e2a` | `a7accd34-6b1e-4a70-a41a-579b456a2309` |
| 采集任务 ID | `57a01914-3d98-4786-9364-b52991fd572d` | `299ad89b-49e1-4211-b739-bf82d34242be` |
| 固定数据运行 ID | `da1910f4-9612-456a-96c8-70fe627c2500` | `2b8034c5-986e-4fbb-9387-1060cc16282d` |
| 分析运行 ID | `485ff5cc-5828-45d2-a020-307bbab2dd03` | `4cb657d2-6376-4c80-8259-8ace35a0c5f0` |
| VOC 报告 | `65a0d1a4-8593-4fd3-88cc-dbd6408ca7f6` v1 partial | `00a8e662-0d8b-403e-ab8a-c6688b2fd898` v1 partial |
| 新品定义报告 | `cfd7676e-f253-41cf-bde1-7a0ade42ec64` v1 partial | `004e10c6-8186-4fb0-acea-9c6da9b66767` v1 partial |

德国原始 5 个 ASIN 全部保留：`B09Q8MJP3R`、`B09GY72DX2`、`B09VP9LJQX`、`B0GCNJJDZP`、`B07KSDSSS1`。

加拿大 3 个 ASIN 来自真实 CA 平衡板类目搜索：`B07DWKNXNY`、`B0GMYQ6B1X`、`B0D4M95CD7`。发现响应与工具 schema 已归档。

加拿大首次分析 `b133f363-2453-466e-a564-f4cc265d233a` 已通过并保留历史。最终代码再次创建上表分析运行，复用同一已冻结的真实采集，未重复采集；公开接口和页面均核对最终运行及其报告。

- [德国站候选报告](http://192.168.1.109:33900/p/playground-fitness-equipment-de?tab=definition&vocRun=485ff5cc-5828-45d2-a020-307bbab2dd03&run=da1910f4-9612-456a-96c8-70fe627c2500&syncJob=57a01914-3d98-4786-9364-b52991fd572d)
- [加拿大站候选报告](http://192.168.1.109:33900/p/balance-boards-ca-candidate-ca?tab=definition&vocRun=4cb657d2-6376-4c80-8259-8ace35a0c5f0&run=2b8034c5-986e-4fbb-9387-1060cc16282d&syncJob=299ad89b-49e1-4211-b739-bf82d34242be)

## 已确认的数据边界

| 模块 | 德国 | 加拿大 |
|---|---|---|
| 目录 | 原采集接收 5/5，修复任务继承；页面仍明确标记其中 1 个上游空值、未验证 | 3/3 |
| 关键词、销量趋势、价格、Listing、类目、原始流量 | 各 5/5 | 各 3/3 |
| 评论来源 | 2/5；修复任务其余 3 个连接失败，未冒充完成 | 2/3；1 个上游无结果 |
| 子体销量 | 0/5，5 个上游无结果 | 2/3，1 个上游无结果 |
| FBA | 3/5，2 个上游无结果 | 3/3 |
| 图片备注 | 33/33 就绪 | 已处理 21/21，19 就绪、2 连接失败 |

报告使用明确标识的本站评论兜底，保留全部选定 ASIN 与缺失覆盖。两个站点的报告均应显示部分覆盖/待进一步验证；链路通过不等于市场证据完整，也不等于立项获批。未覆盖的关注点、购买率、季节趋势、成本利润、专利合规等内容保持未知或待验证。

德国评论为主题出现标签，未捕获原始评论频次或占比；归一化原始样本数 0 表示未采到原始样本，不能解释为商品真实评论总数为零。最终加拿大机会等级为 C，但仍显示评论覆盖 2/3、待进一步验证，商业验证关卡未获放行。

页面的目录文件来源任务目前显示“未关联”，不将其推断填成当前修复任务。VOC/新品定义使用另外保存并校验的固定证据选择，其中项目、站点、基础采集运行、来源任务路径、内容哈希和 cutoff 可由公开分析接口读取。

美国站手工 Alexa 保留原有站点边界。非美国站规范化流量快照仍沿用现有部分支持边界；本次完成了原始流量采集，不能据此声称所有流量分析指标均齐全。

## 修复及失败记录

1. 项目注册、数据库队列和分析输入只允许 US/UK，现统一支持 US/UK/DE/CA；组织、项目、站点和 ASIN 身份仍严格校验。
2. 修正非美国站目录币种、EUR/CAD 图表与数据路径隔离，禁止同 ASIN 的其他站点缓存满足本站就绪条件。
3. 修正同日日期来源被误判为未来时间，采用通过完整性检查的当前任务发布时间；真正未来日期仍拒绝。
4. 子体销量 `-1` 按上游不可用处理，保留逐 ASIN 结果，不填零、不牵连其他 ASIN。
5. 德国真实模型初始失败及诊断重试均保留在账本。一次私有取证确认末尾多一个 `}`；删除这个字符后仍需经过完整 schema、引用和证据校验。已发现的伪造主题引用继续拒绝，不能靠格式处理发布。
6. 单尾括号兼容由候选启动器显式设置 `AGENT_VOC_RELAY_SINGLE_TRAILING_OBJECT_BRACE=1`。默认关闭，仅适用于 relay，记录规则版本、长度与哈希，禁止通用修补 JSON 或猜测证据。
7. 后续实际输出还出现内部 JSON 错误与主题引用错误，因此候选通过小型真实探针后显式选择 `AGENT_VOC_RELAY_RESPONSE_FORMAT=json_object`；默认仍为 `json_schema`。精确输出 schema 继续进入提示词，主题引用限制为本次冻结事实中的合法维度/主题组合，最终全量校验保持不变。`relay-json-mode-probe.json` 保存探针的真实响应与用量；探针只证明参数可接受及一次小输出合法。[官方请求契约说明](https://developers.openai.com/api/docs/guides/structured-outputs)不代表第三方中转自动遵守同等保证。
8. 德国 VOC 在冻结引用与显式 JSON 模式版本上，首个模型调用通过并发布。随后新品定义旧版两次模型输出校验失败，原服务误报为 infrastructure；账本确认实际是 `MODEL_OUTPUT_ERROR`，尚未进入报告保存。已修正产品错误分类及安全日志，并将产品 wire 引用集合限制为同一固定 VOC/关键词输入。历史失败仍保留，未改写为成功。
9. 产品输出增加 16 条封闭规则及对应初始/修复提示，wire 的联合分支表达现有证据侧约束，引用仅可选择当前冻结输入。共享 schema 定义将德国产品 schema 从 67,938 压至 21,368 字符；未提高模型预算、补造引用或放宽最终证据/商业校验。德国新品定义经原有有界修复后通过，加拿大在最终版本上两阶段均通过。

## 验证证据

运行目录 `evidence/` 保存：

- `baseline-before.json` / `baseline-after.json`：正式及原候选进程、提交、指纹对比，以及本候选身份。
- `live-run-state.json`、`*-admission.json`、`*-collection.json`、`*-analysis.json`：公开接口真实创建、采集、分析及报告状态。
- `DE-public-retry*.json`：有界手工重试的请求前状态与公开接口接纳结果；失败不删除、不改写为成功。
- `public-verification.log`：两站两阶段 succeeded、各两份持久化报告，以及同请求体/同幂等键重放返回原分析运行 ID。
- `model-audit.json`、`model-budget-audit.json`、`relay-normalization-audit.json`：已核对 DE/CA 两阶段共 4 个通过的真实模型执行，响应身份与输入/输出 token 均存在，兼容事件与响应哈希对应。汇总用量包含当前运行内保留的历史失败尝试，不能当作仅四次成功调用的用量。
- `backend-tests.log`：相关后端 92 项通过；`json-diagnostics-tests.log`：诊断回归 88 通过、1 个真实 API 默认跳过。
- `relay-compat-tests.log`：当前 provider/runner 94 通过、1 个真实 API 默认跳过；`frozen-references-tests.log`：10 项 VOC 执行与冻结契约通过；`product-definition-tests.log`：17 项产品契约、真实 worker 错误分类及日志回归通过。
- `final-typecheck.log` / `final-build.log`：TypeScript 和稳定生产构建。
- `DE-voc.jpg`、`DE-definition.jpg`、`CA-voc.jpg`、`CA-definition.jpg`：浏览器实际读取最终运行的已保存 VOC 与新品定义。德国还实测从 5 个勾选改为 4 个时隐藏原报告，恢复 5 个并刷新后读回原报告，避免引用错误选区的结果。

已有完整测试套件中的两项 auth 路由调用次数失败已在正式源复现，未通过放宽认证处理。页面渲染测试应不带 `--conditions=react-server` 运行，其 6 项已通过。

VOC 服务完整套件还有 4 项恢复/身份测试失败，已用正式提交 `7efbc72a` 的独立 `git archive` 导出逐项复现相同错误：lease 失效时审计错误消息、报告发布前重启、报告发布后重启、model drift。原测试源 blob 为 `8c1d489c023686422f8c9ae9169b817dcf53bb95`；证据为 `baseline-voc-four-tests.log`。这些失败没有通过改测试或弱化恢复语义隐藏，本次不声称完整历史套件全绿。

最终验收断言均已完成：公开创建接口同键重放保留原分析运行 ID；页面可展开已保存 VOC 并读取新品定义；所有正式/原候选基线对比通过；当前 Agent 命令行为普通 `node --import tsx ./server/index.ts`，一次性私有取证预加载已关闭。独立候选继续保留供用户验收，未合并、未发布到正式环境。
