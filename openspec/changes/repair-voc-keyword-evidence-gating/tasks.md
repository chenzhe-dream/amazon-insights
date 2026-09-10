## 1. 先锁定错误放行（RED）

- [ ] 1.1 在 tests/agent/voc-keyword-evidence-gating.test.ts 调用真实 hasProductLaunchAnalysis 和当前 ProductDefinitionSection，构造零手工、关键词 null、review ready 空 blocks，断言不就绪且不渲染最终结论；运行 `npx tsx --conditions=react-server --test tests/agent/voc-keyword-evidence-gating.test.ts`，记录断言失败而非环境错误。组件渲染使用现有浏览器 fixture，避免 react-server 条件导入客户端 React 的环境错误。
- [ ] 1.2 在 tests/agent/voc-keyword-evidence-selection.test.ts 定义纯选择行为：零手工有效评论但未启用、明确启用、1/3 手工、同 ASIN 缺维度、空白 rows、冲突、模拟记录、错误站点/ASIN、源版本越界；先运行并记录 RED。断言精确的所选主来源、独立分母及缺口，不仅检查计数。

## 2. 授权来源清单与纯选择（GREEN）

- [ ] 2.1 在 shared/agent-contracts.ts 添加版本化清单/请求合同，明确 sourcePolicy 默认 manual-only、selectedAsins 非空唯一子集、baseSyncRunId、expectedInputFingerprint、关键词 ready/empty/failed/missing；在 tests/agent/voc-keyword-evidence-contracts.test.ts 覆盖非法客户端来源内容和非法范围。
- [ ] 2.2 在 server/data/voc-evidence-selection.ts 实现已验证记录的 ASIN/维度选择、手工主来源、显式评论补缺与冲突记录，空主题不可用；复用 server/data/voc-data-snapshot.ts 的 schema 与 checksum，扩展来源清单而不混合统计。运行 1.2 测试至 GREEN。
- [ ] 2.3 在 server/services/voc-evidence-inventory-service.ts 使用现有授权阶段输出读取能力读取 baseSyncRun 的评论/关键词及手工仓库；校验组织、项目、站点、ASIN、版本、时间及指纹。新增 tests/agent/voc-evidence-inventory.test.ts 测全局 generated 不被调用、错误归属拒绝、合法空与失败分开、GET 零写入/零 Provider。
- [ ] 2.4 在 server/routes/analysis-runs.ts 接入 `GET /v1/projects/:projectId/voc-inputs`，复用现有 principal/service resolver，返回清单不创建运行；测试路由未授权、越权、重复 GET 和查询参数错误。清单对两种策略提供可提交指纹，避免点击兜底时拿 manual-only 指纹误判变化。

## 3. 持久输入和幂等提交

- [ ] 3.1 先在 tests/agent/manual-alexa-voc-run-atomicity.test.ts 及对应 PostgreSQL fixture 添加 RED：同键重放同运行、同键不同策略/ASIN 冲突、预览后手工变化冲突且无半写运行、事务失败回滚快照与任务。
- [ ] 3.2 扩展 server/services/analysis-run-service.ts、server/routes/analysis-runs.ts、server/db/manual-alexa-voc-repository.ts 的项目运行创建及 fingerprint；锁手工 scope、数据库时钟、事务重校验与原子持久选择清单。重放优先返回原运行，使用相同请求的 expectedInputFingerprint，不把当前输入变化误作重放冲突。
- [ ] 3.3 同步 server/db/data-snapshot-repository.ts 与 SQLite/PostgreSQL 实现的范围检查，授权 project ASIN 子集但固定 snapshot 范围；测试 1/1、全选、空集、外部 ASIN、顺序规范化及重放身份，不能修改项目原始列表/名称。
- [ ] 3.4 将已校验关键词来源固定为新分析 run 的 KeywordAnalysisSnapshot，保留 baseSyncRun/version/hash 引用；关键词不可用只保存明确缺口，不伪造 snapshot。生产路径使用显式 scoped 评论适配，不落到 RepositoryVocSourceReader 默认 generated 评论或 legacy 样例。
- [ ] 3.5 运行 3.1 的两种仓库回归至 GREEN，所有数据库仅用临时 fixture，禁止连接正式 PostgreSQL。若运行合同须新增字段，迁移必须向后兼容并附测试，不能先修改正式数据库。

## 4. VOC 与联合阶段的真实编排

- [ ] 4.1 在 tests/agent/product-definition-contracts.test.ts 添加 RED：voc-only 允许缺关键词 ID、keyword-candidate 对称、dual-validation 缺任一侧拒绝、未知 ID 拒绝、grade null 及待验证原因、兜底来源 metadata 不得被改成标准。扩展 server/domain/product/product-definition-contracts.ts，保持真实商业审批边界及旧版历史读取。
- [ ] 4.2 同步 skills-src/define-amazon-product-from-voc-keywords 的合同声明和说明及 fixture；按仓库技能版本/hash 注册流程更新 manifest，运行 `npm run skills:validate`。只改文案不能完成 4.1。
- [ ] 4.3 更新 server/runtime/voc-positioning-runtime.ts、server/runtime/product-definition-runtime.ts 与相应 execution service，严格使用本次固定 snapshot 范围/来源版本；缺关键词保持 waiting-input 并提供 empty/failed/missing 原因，零联合 Provider 调用。
- [ ] 4.4 新建 tests/agent/voc-keyword-evidence-runtime.test.ts，以临时仓库与 Fake Provider 跑授权读取→输入清单→固定快照→VOC→联合→保存→GET 全链；测试标准版、评论兜底版、部分覆盖、缺关键词、模型失败、非法身份及迟到发布。日志仅记录 fixture IDs 和状态，不输出真实凭据。
- [ ] 4.5 运行 product-definition-runtime.test.ts、voc-positioning-runtime.test.ts、voc-waiting-input-resume.test.ts、voc-queue-safety.test.ts 和 input ownership 相关回归，保留五分钟 deadline、租约及取消约束。

## 5. 页面改为持久报告与紧凑操作

- [ ] 5.1 在 app/lib/voc-run-browser.ts 添加清单 GET 与项目运行 POST，修复 observeVocRun 将历史报告视为当前成功的判断；在 tests/agent/voc-run-browser.test.ts 先添加 failed+history、running+history、scope/version mismatch RED，再实现按当前阶段/指纹选择。
- [ ] 5.2 修改 app/product-definition-section.tsx，移除本地 builder 生成最终结果，接收可信持久 report、inventory、状态与回调，直接映射报告字段到现有展示；app/lib/saved-analysis-reports.ts 兼容旧版为历史。回跑 1.1，零后台报告时无最终定义/等级。
- [ ] 5.3 在 app/page.tsx 绑定当前 project/base run/所选 ASIN，会话与范围切换中止旧请求；现有模块加入紧凑来源条、ASIN 选择、手工分析/评论兜底/更新按钮。同步 ref 防双击，POST 与 GET 响应均验证 ownership generation；refresh/effect 禁止 POST。
- [ ] 5.4 修改 app/voc-development-summary.ts、server/domain/voc/legacy-summary.ts、app/product-launch-analysis.ts 及定位/推荐/清单调用点，去掉隐式全局评论作为当前 ready 的来源；明确传 scoped 来源，不扩大布局改动。测试 status-only 及局部有资料不冒充整组完成。
- [ ] 5.5 补填手工后 GET 新清单比对 fingerprint，只标历史待更新；明确点击才新建相关分析运行，复用 base run 已有采集结果。新版本失败保留真实失败与历史，不恢复旧版为当前成功。

## 6. 浏览器验收与交付

- [ ] 6.1 新建 tests/agent/voc-keyword-evidence-browser.test.ts 及 helpers fixture，采用现有 voc-review-browser.test.ts 的 Vite/Playwright 方式实际挂载生产页面接线；所有请求指向 fixture，非 fixture 网络立即失败。覆盖首屏/刷新只 GET、双击单 POST、兜底来源条、单 ASIN 分母、缺词三状态、草稿/标准化中、失败保留历史、修改后待更新、跨项目/会话/ASIN 及旧 POST/GET 迟到。
- [ ] 6.2 运行 affected agent 回归及全部本次新增测试，记录 RED→GREEN 证据；执行改动文件 ESLint、`npm run skills:validate`、`npm run build`。使用隔离工作树临时运行根，禁止启动或停止正式 31900/31901/58258。记录全仓 tsc 与已知基线的差异，不能将历史 336 项当作本次实测。
- [ ] 6.3 进行独立代码审查，重点审查默认来源绕过、ASIN 子集持久身份、幂等重放与指纹竞态、schema 兼容、页面无本地假结果及 GET 无副作用；修复实质问题并重跑对应测试。
- [ ] 6.4 写 docs/verification/2026-09-10-voc-keyword-evidence-gating.md：实际改动、命令/结果、浏览器证据、未执行真实验收及发布边界；确认 git diff --check、只修改正确工作树、正式 generated 数据未触碰。不得把仅 helper 测试或仅规格校验描述为完整修复。
