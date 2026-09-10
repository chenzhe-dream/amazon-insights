## Context

动机见 proposal.md。2026-09-10 本任务只读核验：bd63 HEAD b50ba4909e37afbcdabd97e37fab52d899638a73；正式目录、Web codeRelease、Agent codeSource 和 stack.commit 均 6df8a4fd55ce53ddd52a288dbb3c6fbda747673f。正式 sourceHash 为 ab4106860aee126dfee7ef14962b015847ca54df3ac9ec8ff5e169dc5c851e47。6df8a4f 是 b50ba49 祖先，差异只有两份同步文档。

独立开发根：C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/fix-voc-keyword-evidence-gate-20260910；分支 codex/fix-voc-keyword-evidence-gate-20260910。当前 App 默认 cwd 是受保护旧工作树，每条执行命令必须显式 workdir。未发现适用 AGENTS.md。

现有 ProductDefinitionSection 用 useMemo 调用本地两套 builder；page.tsx 已有 scope-bound 评论视图却未传给 productLaunchSources。RepositoryVocSourceReader 默认导入 generated 评论；只改前端 some/every 会遗漏后端。现有 /v1/local-voc 创建名为 Local VOC smoke 的独立项目，不适用于当前项目更新。已有项目运行入口具备事务、手工 scope 锁、数据库时钟、运行幂等与 snapshot 原子写入，应扩展该链。现有 observeVocRun 可能因任一历史 VOC 报告存在而判断 succeeded，需要按当前阶段和版本选择。

## Goals / Non-Goals

**Goals:** 在既有持久链上绑定输入选择与版本，页面展示真实报告；覆盖 ASIN 子集、显式评论兜底和缺关键词。复用快照、运行、报告和权限模块。

**Non-Goals:** 不增加平行无归属缓存，不重构全部产品分析页面，不调用真实 Provider，不修改正式数据，不部署。手工数据读取保留现有授权模型；项目来源校验不擅自重新定义组织内共享手工数据的权限。

## Decisions

### 1. 服务端清单与显式来源策略

在现有 analysis-runs 路由新增项目输入清单 GET；参数为 baseSyncRunId 与所选 asins，项目/组织由授权上下文验证。返回结构由 shared 合同定义：scope、fingerprint、逐 ASIN 的 manual/review 可用性、源标识/版本/hash/时间、维度覆盖及 keywords 的 ready/empty/failed/missing。此 GET 不抓取、不写快照、不入队。

显式创建使用 /v1/projects/:projectId/runs，扩展输入为 sourcePolicy=manual-only|manual-with-review-fallback（缺省 manual-only）、baseSyncRunId、selectedAsins、expectedInputFingerprint 和现有 idempotencyKey。沿用 existing-data，禁止借用 collect-missing 补抓业务。指纹包含范围、策略及源版本；重放同键同请求返回原运行，不因数据后来变化重放失败；同键不同请求返回冲突。

从授权 baseSyncRun 的已发布阶段输出读取评论与关键词，校验 project/run/site/ASIN/版本/hash；通过显式适配器传给快照组装，生产新链不使用 RepositoryVocSourceReader 的默认 generated 来源。无法证明归属的旧 generated 来源保留历史读取能力，不参与新报告。客户不得上传 source contents 或自造证据 ID 来通过清单校验。

输入事务再次读取手工 head、锁定 scope、取数据库截止时间并校验 expected fingerprint，随后原子写入选择清单、snapshot、run 和幂等记录。沿用内容 hash，不能仅比较时间或总 revision。以 snapshot 中持久 selectedAsins 为运行范围；扩展现有把 snapshot.asins 强制等于 project.asins 的校验为已授权非空子集，并使 runtime、报告身份及重放都使用该固定范围，不修改项目列表。SQLite 与 PostgreSQL 同步实现；优先使用已有 JSON snapshot 元数据，只有现有结构无法承载时才新增向后兼容字段。

### 2. 按 ASIN/维度选择，保留冲突

新增纯选择函数接受服务端已验证记录，输出采用的记录与来源清单。有效手工为已保存标准化记录且至少存在一个有效实质主题；草稿、失败、模拟或空主题拒绝。评论逐条 schema 校验并要求非空白主题内容及可追溯源，不把 ready 当内容证据。manual-only 不采用评论。明确兜底时先保留各维度手工主来源，缺失维度用有效评论；同主题异议保留交叉验证证据并标冲突，百分比分开，不补造缺失维度。

选择只过滤/标注已有 evidence，不替模型写结论。来源条展示 ASIN 覆盖，维度缺口另外列出，避免用有一个主题来宣称七维齐全。sourceMode=manual|review-fallback 与 execution status 独立。

### 3. 联合阶段合同与缺关键词

缺关键词时不调联合 Provider，保留真实 VOC 报告；stage/视图的 waiting-input 附带关键词 missing/empty/failed 原因，合法空与错误分别保留。只有关键词时沿用关键词页面候选，不创建伪 VOC 或伪联合报告。这样无需给没有 snapshot 的情况制造 keywordSnapshotId。

对真实双输入任务的联合输出增加版本化输入来源 metadata；矩阵改为有判别字段的单源/双源约束：dual-validation 两侧 ID 非空；voc-only 的 keywordGroupId 可为空、keywordEvidenceIds 为空；keyword-candidate 对称处理；任何非空 ID 必须属于可信依赖。finalDefinition 的 requires-validation 允许缺失侧为空，supported 仍要求相应实质证据。机会 grade 允许 null 并带待验证原因，不能 canonicalize 成 D；评论兜底不能显示“最终A级立项”。新旧 schema 通过版本读取适配，旧报告缺清单视为历史，不回写旧结果。

### 4. 页面只显示持久当前报告

ProductDefinitionSection 去掉 buildProductLaunchAnalysis/buildFinalProductDefinition 的最终结果路径，接收经过 schema 验证的持久联合结果及清单、运行状态与提交回调。现有九块展示用直接字段映射，缺字段显示待验证或不展示，禁止用规则补出内容。VOC 定位、建议及清单三个共享调用点同步去掉隐式 generated 就绪来源，不扩展为无关布局改造。

page.tsx 沿用当前 project/base run/vocRun URL 状态与报告观察，在现有模块放紧凑 ASIN 选择、来源条、开始分析/使用评论兜底分析/更新按钮。未提交时只有 GET；同步 ref 锁防双击，服务端幂等兜住重放。请求所有权键包括 session/project/site/selectedAsins/baseRun/vocRun/fingerprint，切换时 abort 并递增 generation，迟到的提交和读取均校验所有权。不要恢复用户已删除的大块操作模块。

当前结果要求匹配清单 fingerprint、scope、依赖 IDs 及阶段成功。失败/运行中即使存在历史报告也不是当前成功。输入变化只标 stale；点击更新创建固定新输入的分析运行，复用已验证采集数据，旧运行、历史报告和快照保持不变。

### 5. 方案取舍

仅修 some/every：变动少，但仍使用全局来源且没有真实执行门禁，拒绝。新增独立前端推导缓存：展示快，但会再造作用域/版本体系，拒绝。选用既有项目持久运行链：跨层改动较多，但复用权限、事务、worker deadline、幂等和报告历史，是满足交接目标的最小完整路径。

## Risks / Trade-offs

- [ASIN 子集与现有全项目等值约束冲突] → snapshot、重放、worker 与报告身份一起修改，并测试单 ASIN 和非法子集，不能只放宽一个路由。
- [旧报告/旧 schema 没有来源 metadata] → 只读历史适配，不迁移正式历史为“已验证当前”。
- [来源变化与提交竞态] → 预览指纹加事务重校验；同幂等请求优先重放原运行。
- [Provider 输出仍要求双边证据/等级] → 同步更新合同、skills-src 输入输出 schema/说明及 fixtures，用虚构 Provider 测失败，不模板替代。
- [关键词合法空永远卡死任务] → 稳定 waiting-input 及具体原因，不循环重试 Provider。
- [全仓 tsc 既有 336 项问题] → 记录本次诊断与基线差异，不能声称全仓 clean；affected tests、改动 lint 和必要 build 独立执行。

## Migration Plan

先在本隔离工作树完成 RED、实现、回归、fixture 浏览器和独立审查。新 snapshot/输入清单使用版本化结构，新读取器兼容旧历史；如增加数据库字段采用可空增量迁移并对两种数据库验证。发布另行授权，核对最新正式 HEAD 并保留并行修复，不覆盖 generated 数据或切换共享 data/root。回滚代码保留新快照/历史数据，旧版不能把新报告误判标准最终版。当前阶段不执行发布、迁移正式库或服务重启。
