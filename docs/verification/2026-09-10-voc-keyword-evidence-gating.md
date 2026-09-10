# VOC 来源门控与持久报告修复验证

日期：2026-09-10。实施基线：`39db112`。分支：`codex/fix-voc-keyword-evidence-gate-20260910`。

## 工作范围与边界

仅在 `C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/fix-voc-keyword-evidence-gate-20260910` 开发。没有在旧默认工作树或正式服务目录写入代码，没有调用真实 Provider、重启正式服务、部署或修改正式 generated 数据。

收尾只读核对：正式目录与 stack.json 指向 `integrate-xydc-variant-20260905` / `1551ed06305d18922bbc4835ec1d73f90bb9c2e9`；Agent codeSource 同 commit；Web 与 Agent health 均 `ok`。该正式版本由其他工作推进，本次未将修复合入它。共享 data/runtime 根保持原配置。

## 最终行为

- 默认只使用实质手工 VOC。空白主题、仅 ready 状态、局部有数据都不再冒充整组就绪；不再以全局 generated 评论隐式生成新品定义。
- 项目授权的 `GET /v1/projects/:projectId/voc-inputs` 只读取来源。清单分别提供 manual-only 与显式评论补缺策略的指纹，固定 baseSyncRun、选中 ASIN、来源版本/hash/时间及关键词 ready/empty/failed/missing 状态。
- 手工维度始终主导。评论原始证据、单独样本分母和重叠冲突保留；模型收到手工优先、补缺维度和冲突约束，不混合来源占比。
- 仅明确点击创建分析；交易内锁定手工 scope，重新核对指纹，原子保存同 ASIN 范围的 VOC/关键词快照和任务。幂等重放优先于当前来源读取；过期输入、不同策略复用同键、固定范围扩张均拒绝。
- SQLite/PostgreSQL 新增 0031 迁移，允许固定选中子集并保持后续快照身份一致；原项目 ASIN 列表不变。此入口仅创建 VOC/联合阶段，不额外启动流量或采集任务。
- 联合任务只在持久 VOC 与关键词依赖就绪后执行；缺关键词零联合模型调用。模型失败保留 VOC 与历史结果。
- 浏览器新品定义直接呈现持久报告；当前结果要求同 run、阶段成功、相同选择指纹和关键词 ready。修改输入只刷新 GET、旧结果标历史；跨项目/会话/ASIN 以及迟到 GET/POST 均隔离。URL 保留 vocAsins 与历史 run。
- 共享输出 schema 支持单源矩阵和 grade=null 原因，同时限制双源证据、商业验证及兜底等级；所有非空证据 ID 校验可信归属。
- Provider 输入只接收去授权身份的来源投影。新增可选 responseSchema 只负责模型严格响应格式，可信 schema/canonicalize 负责验证、审计与发布；两者使用同一可信结果，未放宽数据库审计一致性。
- 技能分别升级为 `amazon-voc-insight@1.0.1` 与 `define-amazon-product-from-voc-keywords@1.1.0`，同步 agent definitions 和内容 hash。旧技能注册记录保留时升级链也能运行。

## RED → GREEN 证据

1. 旧默认评论与 ready 空块错误放行：新增真实 selector/ready 测试先失败，再默认关闭隐式评论并过滤空主题。
2. 浏览器未点击却显示“评论兜底版”：Playwright 断言失败后分离可用来源预览和本次固定输入。
3. keyword record error 被标 empty：断言 `empty !== failed`，修复状态分类。
4. 修改 manifest 指纹仍通过快照：断言 `true !== false`，加入来源清单指纹/覆盖校验。
5. 单 ASIN 持久化：先由数据库旧全量范围约束拒绝；两库迁移后通过。
6. 完整 Worker 捕获纯合同测试未发现的问题：模型输入授权身份被安全树拒绝、严格响应格式不支持 optional metadata、审计和发布结果不同。最终通过安全输入投影及独立 responseSchema 修复，保留安全树和审计约束。
7. 旧技能 version+hash 注册冲突：先预注册旧 manifest 重现失败；提升版本后完整四场景通过。

## 验证命令与结果

所有数据库为内存/临时 SQLite 或隔离 Docker PostgreSQL；Provider 为测试注入实现。浏览器挂载生产 `VocEvidenceDefinition` 及真实报告 renderer，API 为路由夹具，非本地夹具网络立即拒绝。没有进行真人数据或正式环境业务验收。

| 检查 | 结果 |
| --- | --- |
| 14 个来源、快照、合同、预处理、SkillRunner 与运行相关测试文件组合 | 142/142 通过 |
| 技能升级后 `skill-runner.test.ts`、`voc-product-evidence-contract.test.ts`、`voc-keyword-evidence-runtime.test.ts` | 61/61 通过 |
| `voc-keyword-evidence-runtime.test.ts`（上述组合内） | 4/4：真实手工仓库标准版、评论兜底、缺词零联合调用、模型失败保留 VOC；预先注册旧技能 |
| `voc-evidence-run-atomicity.test.ts` | SQLite/PostgreSQL 2/2；含单 ASIN 双快照、固定范围拒绝扩张、同键冲突、原子回滚、来源变化拒绝与原运行重放 |
| `voc-keyword-evidence-browser.test.ts` + `product-definition-section.test.tsx` | 13/13；包含首屏/刷新 GET、双击单 POST、固定兜底来源、输入改变历史、跨范围迟到请求隔离、非法/单源结果 |
| 新增授权 GET route 测试 | 1/1；无会话、越权项目、重复 GET 零写入、非法 ASIN 查询 |
| 扩展相关回归（8 个文件） | 159 项，150 通过、9 失败；与独立 39db112 副本的 9 个失败名称完全一致 |
| 改动 TS/TSX ESLint（除 page.tsx 的原有问题） | 无新增错误或警告 |
| page.tsx ESLint | 9 errors / 8 warnings；独立 39db112 基线相同 |
| `npm run build` | 通过，最新生产构建完成；未启动产物 |
| `npx tsc --noEmit --pretty false` | 336 项；39db112 实测同为 336，按文件+错误类型无新增 |
| 两个改动技能 registry.load | 新版本与 hash 均通过 |
| `npm run skills:validate` | 全局门禁未通过：alexa-for-shopping-voc/SKILL.md 与发布 ZIP 不同；39db112 副本同样失败，未覆盖原始 ZIP |
| `git diff --check` | 通过 |
| 独立审查 | 最终 PASS；独立合同与 renderer 测试 11/11 |

测试命令统一为 `npx --no-install tsx --conditions=react-server --test <文件>`；客户端 renderer/Playwright 组合不带 react-server。运行日志保留在本工作树 `.superpowers/sdd/evidence-*.log`，TypeScript 基线与收尾日志为 `tsc-baseline.txt` / `tsc-delivery.txt`。

## 已核对的基线失败

- lifecycle routes validate shared contracts and use only server execution context
- an authenticated local workspace registration makes the same project identity eligible for scoped sync
- authenticated lifecycle routes derive actor and organization from the session principal
- product definition waits with exact dependencies and auto-runs after keyword snapshot arrives
- product validation failure preserves persisted VOC and keyword dependencies
- service derives target and cutoff from the trusted run and project
- ordinary logs contain only summary metadata and logger failures are harmless
- only successful tenant misses invoke owner-gated legacy per missing ASIN
- missing VOC waits and a validated file import resumes the same durable job

这些失败与全仓 tsc、全局 ZIP 门禁仍需另行处理，不能把本次修复描述为全仓全绿。

## 独立审查处理

已修复审查指出的评论异议丢失、失败后重试旧幂等键、单 ASIN 刷新恢复、缺词时兜底来源误标、配置/优先级伪造证据 ID、共享结构约束不足。最终审查同时确认 responseSchema 未替代可信校验，发布仍使用 audited.value。

[浏览器历史报告证据](2026-09-10-voc-keyword-evidence-history.png)。截图使用 fixture 文本，不含真实业务数据。

后续发布前需要针对正式版本 1551ed0 或届时最新版本另行合并验证；本次没有授权或执行发布。


## 用户委托补充验收（2026-09-10）

用户明确由开发侧完成验证，无需用户在线上试错。本轮仅在独立工作树运行测试，没有启动、重启或部署正式服务，没有调用真实 Provider。

- 后端验收 16/16：真实 worker 配合注入 Fake Provider，覆盖手工优先、显式评论兜底、缺关键词等待、生成失败保留 VOC；同时通过隔离 SQLite/PostgreSQL 的快照、回滚、重放和输入变更检查。
- 浏览器及报告渲染 14/14：新增“已有报告 → 新分析失败 → 旧报告标为历史 → 刷新仍保留历史且不新增提交”场景。测试 harness 补齐与正式页面相同的 vocHistory 参数传递；没有修改产品实现。
- 合约、选择策略、快照范围、SkillRunner、浏览器状态回归 92/92。
- 合计本轮 122/122，通过修改测试文件的 ESLint 与 git diff --check。
- 浏览器使用生产组件和模拟 HTTP 响应，后端使用真实 worker 与 Fake Provider 分别验证；这不等于真实 Provider 或正式环境的连通性测试。全仓既有失败仍见上文。

日志：`.superpowers/sdd/evidence-user-acceptance-backend.log`、`evidence-user-acceptance-browser.log`、`evidence-user-acceptance-regression.log`。
