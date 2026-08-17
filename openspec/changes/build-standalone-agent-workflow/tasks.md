## 1. 恢复可开发基线

- [x] 1.1 停止占用仓库依赖的开发进程，核查现有 `package-lock.json` 差异，恢复与 `package.json` 一致的依赖树，并记录不属于本变更的锁文件来源
- [x] 1.2 运行现有 build、test 和 lint，保存基线失败清单；只修复阻止后续 TDD 的环境问题，不顺带修改业务结论
- [x] 1.3 添加 Node Agent Service 所需的最小运行与测试依赖、`agent:dev`/`agent:start`/`test:agent` 脚本，并验证空服务测试可以独立运行
- [x] 1.4 将过期的 Sites starter 渲染测试替换为当前 Amazon 应用的服务端渲染契约，并在不禁用规则、不改变业务结论的前提下消除现有 ESLint error，使 `npm test` 与 `npm run lint` 恢复为可合并门禁

## 2. 定义 Web 与 Agent Service 协议

- [x] 2.1 创建共享的用户、项目、AnalysisRun、RunStage、DataSnapshot、AgentRun、AnalysisReport 和标准错误 Zod 模式
- [x] 2.2 创建版本化 HTTP 协议，覆盖健康检查、登录/退出、项目、运行创建、状态查询、重试、取消和报告读取
- [x] 2.3 实现 vinext 侧类型安全 Agent Service 客户端与仅服务端可见的内部地址配置，确保浏览器不直接访问内部服务或秘密

## 3. 建立 Node Agent Service 基础

> 执行优先级：本变更以“复现现有分析能力并验证 ZIP Skill 可脱离 Codex 运行”为第一目标。先完成 3、5、7、4.1/4.2、6、8、9、10 和 11 的复现关键路径；内部登录与成员权限（4.3）以及 PostgreSQL 生产适配（4.4）在纵向切片和新旧对照通过后再实施。

- [x] 3.1 创建端口 3100 的 Node HTTP 服务、配置校验、请求标识、结构化错误和优雅关闭，并为健康检查编写集成测试
- [x] 3.2 实现请求体限制、超时、来源限制、日志脱敏和内部代理认证，验证 vinext 代理可调用且直接未授权请求被拒绝
- [x] 3.3 增加本地双进程启动说明和服务能力端点，使页面能区分 Agent Service 未启动、配置缺失和连接器不可用

## 4. 建立持久化（内部账号后置）

- [x] 4.1 为 SQLite 创建版本化迁移，包含 users、sessions、projects、analysis_runs、run_stages、job_attempts、data_snapshots、skill_versions、agent_runs、analysis_reports、connector_status 和 audit_events
- [x] 4.2 实现 SQLite WAL、事务、Repository 接口、幂等约束和数据库级任务租约，并覆盖并发领取、租约回收和重复请求测试
- [ ] 4.3 在复现纵向切片通过后，实现一次性管理员初始化、scrypt 密码哈希、可撤销会话、安全 Cookie、登录限流以及 admin/member 权限测试
- [ ] 4.4 实现 PostgreSQL Repository 适配器和同一迁移模型，使用生产方言验证并发领取、事务、幂等和重启恢复

## 5. 把 ZIP Skill 转成版本化运行源

- [x] 5.1 将三个 ZIP 的 Skill、引用资料和图标展开到受审查源目录，保留原 ZIP 作为来源证据且不执行包内代码
- [x] 5.2 为每个 Skill 添加 manifest、语义版本、内容哈希、输入/输出模式、允许引用和测试样例，并实现静态校验命令
- [x] 5.3 实现 Skill Registry/Loader，只加载注册版本和允许的 Markdown/引用，缺失文件或哈希不一致时拒绝运行
- [x] 5.4 定义竞品流量、VOC 定位、最终产品定义三个 Agent Definition，并验证其 Skill、模式、预算和依赖均可解析

## 6. 实现持久任务与静态编排器

- [x] 6.1 实现 JobAttempt Worker Loop、租约心跳、优雅停止、错误分类、有限退避重试和 `waiting-input`/`budget-exceeded` 状态
- [x] 6.2 实现 TypeScript `AnalysisOrchestrator` 静态依赖图，支持可运行节点发现、并行独立阶段、单阶段重跑和下游 stale 标记
- [x] 6.3 实现分析运行的幂等创建、页面刷新恢复、取消和失败阶段重试，确保成功阶段不会被重复执行或覆盖
- [x] 6.4 实现调用级、运行级和组织每日 Token/费用预算，验证达到任一上限后不再创建模型请求

## 7. 实现 OpenAI Skill Runtime

- [x] 7.1 使用 OpenAI 官方 SDK 和 Responses API 实现结构化生成适配器，模型和参数由管理员配置且不写死在 Skill
- [x] 7.2 实现输入白名单、秘密字段拒绝、输出 Zod 校验、一次格式修复和两次暂时错误重试，并使用假提供商完成契约测试
- [x] 7.3 保存 Skill 版本、数据快照、模型、响应标识、Token、耗时和费用估算；普通日志只保存摘要元数据并通过脱敏测试
- [x] 7.4 禁止 Agent 输出递归启动 Agent 或未声明工具，并为越权工具建议、无限循环和预算绕过编写负向测试

## 8. 完成首个 VOC 纵向切片

- [x] 8.1 从仓库已有 VOC/评论数据生成带来源和截止时间的不可变 DataSnapshot，不修改现有生成数据文件
- [x] 8.2 抽取并复用 VOC 主题、占比、P0 安全规则和证据索引等确定性 TypeScript 预处理，建立与旧逻辑一致性测试
- [x] 8.3 执行 `define-amazon-voc-positioning` Skill，生成通过模式与业务不变量校验的版本化 `analysis-result`
- [x] 8.4 在 vinext 页面接入创建运行、阶段进度、错误动作、VOC 智能体结果和历史版本；Agent Service 离线时显示可操作提示
- [x] 8.5 验证“已有数据 → Skill → OpenAI → SQLite → 页面 → 刷新后仍存在”的端到端验收链路

## 9. 建立新旧对照与发布评测

- [ ] 9.1 固化滑板车、灯具、缺失数据、口径冲突和安全 P0 五类脱敏输入快照及确定性预期
- [ ] 9.2 实现自动评测器，检查模式、数值、证据、数据边界、虚构数据、安全降级、回退和历史版本不覆盖
- [ ] 9.3 实现人工评分记录和模块级功能开关，使旧规则为默认主结果、智能体结果可后台对照并可即时回退
- [ ] 9.4 只有自动门槛全通过且人工评分达标后才切换 VOC 模块主结果，并记录 Skill/模型/评测集版本

## 10. 接入其余两个智能体

- [x] 10.1 复用现有流量确定性计算，执行 `analyze-amazon-competitor-traffic` Skill，并验证流量能力不被表述为盈利效率
- [x] 10.2 保持流量与 VOC 独立运行，验证一个失败不会删除或阻塞另一个成功结果
- [x] 10.3 在 VOC 定位与关键词分析依赖满足后执行 `define-amazon-product-from-voc-keywords` Skill，缺少商业数据时保留立项边界
- [x] 10.4 将三个模块结果按同一版本化报告协议展示和导出，页面与导出读取同一保存版本

## 11. 去除 Cursor 依赖并接入数据连接器

- [ ] 11.1 将 SIF、Sorftime、SellerSprite 客户端改为仅从服务端秘密读取配置，删除 `~/.cursor/mcp.json` 读取与相关用户提示
- [ ] 11.2 为三个远程 MCP 建立统一连接器契约、健康检查、超时、限流、重试、响应解析、错误脱敏和来源元数据
- [ ] 11.3 将现有采集脚本逐步包装成 DataSnapshot 任务，不再生成或热改页面 TypeScript 文件作为生产发布机制
- [ ] 11.4 保留 Amazon/Alexa VOC 粘贴和文件导入；缺失时进入 waiting-input，导入成功后恢复后续阶段

## 12. 生产化、安全与交付验收

- [ ] 12.1 配置同机双进程本地/生产启动、健康检查、优雅重启和 PostgreSQL 环境，验证 Web 重启不丢任务且 Agent Service 重启可恢复租约
- [ ] 12.2 完成管理员连接器状态、密钥轮换审计、普通成员权限、秘密脱敏、请求限制和模型数据最小化安全测试
- [ ] 12.3 运行 agent 单元/集成测试、vinext build、现有回归测试、端到端浏览器验收和 OpenSpec strict validation，并保存完整证据
- [ ] 12.4 逐任务分支/worktree 审查并合并到 `feature/agent-runtime-mvp`，确认 `package-lock.json` 只含已批准依赖变化后再准备合并 `main`
- [ ] 12.5 将独立 Playwright Browser Worker、正式报告审批和 LangGraph 技术试验登记为后续 OpenSpec change，不混入本次 MVP

