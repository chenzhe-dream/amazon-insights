# 保存与重开实施核对

## 现有契约

- 本地规则链路为 `LocalVocDefinition → LocalProductDefinitionSection → buildProductLaunchAnalysis / buildFinalProductDefinition`，原先只在页面内存生成。
- 旧历史入口读取 `/v1/runs/:runId/reports`。这些是 AI 执行报告，使用 `analysis_reports` JSON 载荷，发布依赖运行、阶段、租约与模型执行标识；不把本地规则结果伪装成该执行。
- `ProductDefinitionOutputShapeSchema` 为严格的 AI 输出结构；`canonicalizeProductDefinitionOutput` 删除模型提供的规则记录，不能把当前规则版本回填旧 AI 报告。
- 本次添加 `/api/local-rule-reports` 保存本地规则报告，文件存于既有运行时 `dataRoot/local-rule-reports/<组织哈希>/<项目哈希>`。遵循现有运行时文件存储模式，不新增数据库表或迁移。保存整份结果及可选规则记录，重开不重新计算。

## 数据和授权

- GET/POST 均复用 `/v1/auth/session` 和 `/v1/projects/:id`，检查新品定义模块、组织、项目及 ASIN 范围；POST 检查同源请求。
- POST 不接受客户端规则解释。商品标题、类目及有界描述来自页面提交的输入快照，保存来源文案明确其性质；这不声称是服务端采集记录。服务端重新执行共享规则。
- 手工 VOC 通过已有 `/v1/manual-alexa-voc` 项目授权读取；有采集运行和任务时，关键词/评论通过现有按项目、运行、任务隔离的阶段输出读取。来源读取失败明确失败，不回退全局生成文件。
- `readGeneratedRuntimeAnalysisData` 读取全局生成数据，未用于该保存接口。现有 catalog 没有可复用的按项目阶段输出；因此不能把客户端商品描述标成服务端 catalog。
- 保存的范围包含组织、项目、站点、ASIN 集合、输入修订和实际规则版本。修订包含商品输入、VOC 修订/哈希、阶段输出版本/哈希及兜底模式。规则引擎进一步计算实际输入标识，保存使用引擎输出的标识。
- 重开使用保存的规则定义、条件、决策，不使用当前规则目录重新解释。可选 `sourceBindings` 记录手工 VOC 修订/内容哈希及阶段运行/任务/状态/版本/哈希。GET 经现有授权接口核对这些绑定；来源删除、权限拒绝或读取失败返回不可用状态，来源版本改变返回历史状态，并移除响应中相关来源原文（含所有嵌套规则记录与上下文中的 evidence/needs）。存储文件及生成时判断不变。旧载荷没有绑定时明确显示无法核对，不伪造来源仍有效。
- 阶段接口即使返回 HTTP 200，只要阶段失败或部分完成，也以 422 拒绝保存并指出需补齐关键词/评论来源；不以空数据继续生成。

## 验证

`tests/agent/local-rule-reports.test.ts` 覆盖 A11 范围/版本/修订隔离，A14 保存重开、历史版本、无记录不伪造及 AI 伪造字段处理，A15 模块/组织/项目/ASIN、来源失效及外部范围引用拦截。页面保存和历史展示由 UI 接入另行验证；本文件不代表浏览器验收或发布完成。
