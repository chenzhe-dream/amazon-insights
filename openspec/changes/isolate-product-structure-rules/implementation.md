# 实施与验收记录

状态：代码、离线/接口/组件浏览器验收和构建完成；尚未发布，未宣称生产业务验收通过。

## 实际范围

正式工作区：`integrate-xydc-variant-20260905`。实施前备份位于外部运行目录 `backups/structure-rules-start-20260916`，本次差异清单保存于 `.superpowers/sdd/structure-scope-diff.json`。只调整 VOC、关键词参数、新品定义及其规则展示/保存路径；未恢复历史证据三期。

- `shared/product-structure-rules.ts`：规则版本 `product-structure/1.1.1`，产品信息、三态及冲突、事实/建议判定、按 ASIN 分组、版本与范围隔离。
- `app/lib/product-structure-analysis.ts`：现有输入适配、逐 ASIN 有依据动作、最小来源引用、最终结果消费。同一段混合 ASIN 动作再次进入最终定义时，先按原 ASIN 标记拆分，避免邻项硬件影响本项。
- `app/keyword-demand-conclusions.ts`：人群仅形成适龄核对；形态、功能和规格词先作为需求假设，正式消费者只取通过判定的 `acceptedValue`。
- `app/product-launch-analysis.ts`、`app/voc-positioning.ts`、`app/final-product-definition.ts`：修正家族模板入口，保留未知类目原始主题；基础功能、材质、开发优先级及最终功能分层均不得从未经判定的词表直接生成硬件配置。
- `app/analysis-rule-explanation.tsx` 及相关页面：当前 R01–R12 规则目录与生成时快照分别展示；结果级判断和未采用建议可查看原因、来源、ASIN、条件及实际规则版本。
- `app/api/local-rule-reports`、`app/lib/local-rule-report-*`、`server/services/local-rule-report-store.ts`：复用会话、模块与项目权限，从当前授权来源重新生成并保存不可变结果；重开不重新执行当前算法。实现细节见 `persistence-notes.md`。

## 明确的行为边界

1. 商品别名和搜索原词保留；`Snow Scooter` 不等同于轮式结构。结构未知、明确不具备与来源冲突分别处理。
2. 缺失/不适用只影响相关候选。包装改进、连接强度、容量取放等有依据动作继续输出；不会整表统一替换成笼统占位。
3. 建议可提出竞品尚无的新设计，但必须同时有相关需求、结构适用条件和验证项。包装图案出现“车轮”不能支持改三轮。
4. 保存按钮是“生成并保存规则结果”：保存时读取项目当前已授权来源，可能与稍早屏幕结果不同；显示保存版本后，不再执行现行规则冒充历史判断。旧报告无轨迹时明确说明未记录。
5. 来源更新/删除/无权限时，隐藏对应旧来源原文、标注状态，保留已保存的结果与当时版本。失败或不完整的采集阶段不会静默保存成完整来源。
6. 未新增外部采集、模型调用或数据库迁移。此版本仍需实际结构资料；不声称仅凭标题即可覆盖所有未来类目。新增模块须提交明确候选、条件和来源，复用共享判定接口。
7. **评分公式和阈值未重写，但不承诺所有旧分数不变。** 原轮式/灯具模板不再因产品族标签自动入选；参与评分的候选及相应输入会变化。旧快照测试中固定硬件动作和丢弃未知主题的预期已按本规则更新；原始聚合占比、P0/P1 断言和领域优先级边界继续独立回归。

## 验收证据映射

测试路径均位于 `tests/agent/`。

| 验收 | 自动化 / 浏览器证据 |
|---|---|
| A01–A03 雪地/三轮/两轮 | `product-structure-rules.test.ts`、`product-structure-integration.test.ts`；既断言不串轮式结构，也断言真实三轮稳定性动作仍通过 |
| A04–A06 融蜡/阅读/未知类目 | 同上；温控“不稳定”不误走重心分支；未知收纳类目保留容量/取放并进入定位表 |
| A07 混合与顺序 | 核心分组测试和集成测试；比较每 ASIN 来源与动作，最终开发优先级仍保留雪地自身有效动作 |
| A08 否定和人群限制 | 核心否定语义测试及集成目标人群原文检查；不由 toddler 自动认定适龄 |
| A09 新增设计 | 核心新增可调握把与真实稳定性需求测试；不把“当前没有”当永久禁止 |
| A10 冲突 | 核心标题/属性冲突、同句两轮三轮、无轮与三轮并存；保留双方引用并局部核对 |
| A11 范围和版本 | 核心缓存键、混合范围拒绝与 `local-rule-reports.test.ts` 范围测试；切换选择时清空显示状态并中止过期请求 |
| A12 规则目录 | `analysis-rule-explanation.test.tsx`；无结果也显示完整当前目录；浏览器 `structure-ui-empty-desktop.png` |
| A13 结果解释 | UI 测试与 `structure-ui-loaded-desktop.png` / `structure-ui-loaded-mobile.png`；正式动作不混入拒绝候选 |
| A14 历史兼容 | `local-rule-reports.test.ts` 保存/重开/版本快照；`local-product-definition-snapshot.test.tsx` 用禁止访问的当前输入验证保存结果不被重算；`structure-ui-legacy-mobile.png` |
| A15 权限和失效 | 报告 API 测试覆盖模块/跨组织/项目/ASIN/伪造轨迹/来源失效；真实模拟上游删除、403、503、阶段404及HTTP200失败/部分完成；UI缺失引用提示 |
| A16 下游一致性 | `keyword-structure-formal-actions.test.ts`、`final-structure-downstream.test.ts`、集成测试；功能层、方案材质、优先级和词群承接不能绕过统一判定 |

浏览器材料在 `.superpowers/sdd/structure-ui-*`，使用当前组件的独立 SSR 验证页，无真实账号或生产数据；验证键盘 Tab/Enter 展开和 390 px 窄屏。接口鉴权与保存回放由独立 API 测试验证；不将 SSR 样张称为生产端到端验收。

首次雪地错误复现：`.superpowers/sdd/structure-integration-red.log`。混合最终消费先失败再修复：`structure-mixed-final-red.log` 与 `structure-mixed-final-green.log`。审查追加了复合事实、否定事实、无关痛点、同句矛盾、重复来源 ID 等反例。

## 业务验收步骤与回退

1. 在测试版本选择雪地产品，查看原名保留、连接强度建议，以及未采用的轮式建议原因；再选真实三轮，对照有效稳定性建议。
2. 分别查看融蜡灯、阅读灯与收纳类目；检查动作围绕实际用途。混合选择商品时，核对动作的 ASIN 归属。
3. 展开“分析规则说明”和行内“为什么这样判断”；无结果也能阅读规则。检查当前目录与保存时规则版本分别标识。
4. 生成保存结果后切换选择、重开对应范围的历史版本；确认历史按保存版本展示，来源变更明确提示。
5. 无权限人员不能通过报告接口访问受限模块或其他项目。

本次不执行发布。发布需按任务 5.4 的正式栈流程；届时再核验部署版本、入口和健康。局部回退须按本次差异清单逐文件撤回接入，保留期间无关改动与历史报告；禁止整仓 reset、整站回滚或删除 VOC 数据。备份只是比较基线，不可不审查就整目录覆盖。

## 最终验证结果（2026-09-16）

- 服务端与核心规则：35/35，通过。日志 `.superpowers/sdd/structure-server-final.log`。
- 集成、界面及原有功能：68/68，通过。日志 `.superpowers/sdd/structure-client-final.log`。
- 原有关键词复制真实浏览器回归：1/1，通过。日志 `.superpowers/sdd/structure-copy-regression.log`。
- 合计 104 项通过，无失败/跳过；全仓 `npm run typecheck` 通过，日志 `structure-typecheck-final.log`。
- 独立目录 `C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/verification/structure-rules-20260916-final` 执行 `npm run build` 通过；日志为该目录 `build-verification.log`。未触碰正式工作区 dist、未切换线上进程。
- 构建副本与实施源码指纹一致：`4fde6e0275df2145e4e983f667002f504b64e4bfc6df8a4e204f54fbd8a78dbd`。
- 当前版本完整界面截图：`structure-ui-v1.1.1-final-desktop.png`、`structure-ui-v1.1.1-final-mobile.png`。含 26 处行级说明、6 处功能卡说明；加载实际 comparison-layout.css 后，390 px 视口文档无横向溢出，宽表在内部滚动。独立规则页同时验证空结果和历史无记录状态。
- 限定差异 lint 未全绿：关键词复制区保留两项本来就存在的 Hooks lint 错误（refs / set-state-in-effect）；对实施前备份用相同 ESLint 命令复验，同样出现这两项错误。日志 `structure-all-lint.log` 与 `structure-baseline-keyword-lint.log`。未为修复本次规则而改动复制逻辑；其浏览器回归通过。其余限定文件无 lint error，存在未使用旧辅助函数和 img 提示，未将 lint 宣称为全部通过。
- 所有测试与样张均使用脱敏/构造样本；未消耗 Sorftime/卖家精灵额度，未用生产数据重写历史报告。

任务 1.1–5.3 已勾选，5.4 发布保持未完成。后续业务可依据上述步骤验收；规则新增或修改必须同时更新版本、中文条件/例子、指纹与回归用例。

## 原数据复验后的修正

上述 1.1.1 为先前构造样本验证记录。后续七 ASIN 原始数据回放发现适用语义与摘要旁路，已按任务 6 修复为 1.1.2；当前结论、流程映射、97 项回归和实际数据复验证据见 [real-data-repair.md](real-data-repair.md)。保留原验证历史，不将旧样本通过当作真实业务验收。当前仍未发布。
