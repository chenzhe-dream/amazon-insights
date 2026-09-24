# 前端一期验收记录

日期：2026-09-24。基线：2ca3ae27060672739e997dea028a21408c5b0ede。
独立分支：codex/favorite-html-export-ui。

## 本期结果

- 已收藏的竞品分析项目显示“导出”；未知、读取中、保存中或未收藏状态不开放入口。
- 同页悬浮窗支持模块勾选、范围预览、取消、Escape、焦点约束和关闭后恢复焦点。
- 仅展示当前可见模块；选择变更不触发分析、模型调用、业务写入或文件下载。
- 展示项目真实元信息，分析内容明确标注待接入；最终导出按钮禁用。
- 搜索请求刷新列表不会卸载预览或清空选择；保留原搜索、分页、收藏、加载、编辑行为。

## 验证

1. 新增导出浏览器用例在实现前因缺少按钮失败（2 项），实现后通过。
2. `node node_modules/tsx/dist/cli.mjs --test tests/agent/analysis-project-favorites-ui.test.tsx tests/agent/project-library-pagination.test.ts`：19/19 通过。
3. `npm run typecheck`：通过。
4. 新组件及测试文件 ESLint：通过。对修改前 HEAD 与修改后集成文件逐条比较 ruleId、severity、message，诊断完全一致：app/page.tsx 保留原有 8 个错误、11 个警告，project-library-panel.tsx 保留原有 1 个警告。未声称全仓 lint 通过。
5. `openspec validate add-favorite-html-export --strict`：通过。
6. `git diff --check`：通过。
7. 浏览器测试覆盖 390×680 窄屏，弹窗不越界，无水平溢出；已人工检查桌面截图。

截图：本工作区 test-results/favorite-export-modal.png，由测试生成。
浏览器使用真实前端组件和受控测试接口；没有读取或导出正式业务报告，本期不涉及真实模型额度。

## 后端交接

按照 tasks.md 第二期逐项接入：核实各模块数据归属和完整性 → 生成固定快照 → 使用同一快照与模板渲染预览和离线 HTML → 生成与下载 → 完整性和权限验收。

不能把本期模块目录当成数据已就绪清单。所有 ASIN、分页数据与折叠详情均需完整处理；缺失内容必须明确标注，不填零，不用示例替代，不自动重新分析。

本次没有后端、数据库、采集配置或部署改动。正式环境未发布。另一个开发窗口的改动未合并。

## 本地工具说明

依赖锁文件与基线一致，node_modules 复用基线工作区依赖，未安装或修改包。
初次测试产生的 .cache/favorite-ui-vite 目录清理被自动审批以 blocked by policy 拒绝；保留为未跟踪缓存，不纳入代码提交。后续测试缓存已置于忽略的 test-results 目录。

## 2026-09-24：简化计划后的第一模块

用户批准浏览器 HTML 快照方案，并要求逐模块实施。以上一期“后端交接”是历史记录，本轮以现行 design/spec 为准：没有服务端导出任务、文件存储或离线图片打包。

### 已实施范围

- 接通收藏项目 → 悬浮预览 → 勾选概览 → 准备完整已有结果 → 重新核验资格 → 下载同一 HTML。
- 竞品概览包含参数、已有类目趋势及竞争指标、完整销量/销售额/价格/排名历史、披露子体销量、价格策略、规格、卖点原文与已存在的中文翻译。没有调用翻译生成接口。
- 读取链路为收藏 ID → 显式 sourceProjectId（无映射时只尝试自身合法项目 ID）→ 授权分析项目 → 已发布显示版本；检查组织、站点、ASIN、运行及阶段来源。没有按名称或同 ASIN 查找别的项目。
- 当前来源项目契约仍限定 US。不能把适配器的站点格式化能力解释为已端到端支持非 US；本轮没有放宽原业务契约。
- 卖点原文选择函数原样移动至 shared/selling-point-source.ts，服务端从原路径重新导出；翻译业务逻辑未改。补读缓存翻译会核验原文并重复校验读取一致性。明确未配置服务可保留原文并注明不可用；网络错误、来源不一致、读取期间变化会阻止准备完成。
- 按每次选择变更生成不同代号，关闭或变更后取消旧请求；下载核验失败清除正文。项目 ASIN/站点范围变化也会失效，不刷新正文替代已预览内容。
- 其余七个模块仍为“内容待接入”且禁选；没有伪装成业务缺失。整项 OpenSpec 未完成。

### 检查与实际下载

1. HTML 核心及来源适配新增用例曾在缺少实现时失败，实现后通过。UI 用例初次失败含 fixture 与测试文件扩展名问题，不能当作功能回归的有效红灯证明。
2. 最后一次六文件相关回归共 43/43 通过：project-export-download-ui、project-export-sources、project-export-overview、project-export-html、analysis-project-favorites-ui、project-library-pagination。
3. 卖点翻译与 HTTP 回归 5/5 通过。HTTP 用例需要项目既定 --conditions=react-server；未带该条件的首次执行失败于 server-only 导入，不是业务失败。
4. npm run typecheck 通过；新增文件与导出目录定向 ESLint 无错误/警告；project-library-panel 仍有原有 useCallback 依赖警告，不声称全仓 lint 清零。
5. openspec validate add-favorite-html-export --strict 通过；git diff --check 通过。
6. 浏览器真实下载文件与 iframe srcDoc 逐字一致。准备之后修改模拟接口价格，下载保持旧预览价格，确认过程没有再请求显示版本。新建无登录 browser context 打开已保存 HTML，正文、表格、样式正常且无应用 API 请求。
7. 已覆盖 100 行表格、30 个月趋势、全部 8 条披露子体、空值不填零、HTML 转义、危险图片 URL 拒绝、缓存翻译变化、权限变化、取消收藏、ASIN 范围变化及重新勾选的旧预览失效。
8. 浏览器测试拦截测试图片外网请求，避免外网图片延迟导致 load 超时；因此不把它当作真实图片来源可用性验收。线上公开 HTTPS 图片依然按计划使用在线链接。

截图：test-results/favorite-export-overview-preview.png。使用真实 React 组件与受控接口/脱敏样例，未读取正式业务报告、未消耗模型额度、未发布。

### 性能记录与限制

纯 HTML 生成单次样例：30 行 13,859 字节，12.82 ms；后续同进程 1,200 行 442,341 字节，2.17 ms。前者含首次格式化初始化，两者不是严谨的规模性能对比。没有实际网络读取时延数据，不承诺正式环境固定秒数；准备阶段有 60 秒超时和取消。完整各模块性能验收继续保持未完成。

### 下一模块：变体 / 订单来源核查

- 原页面 XydcVariantSection 使用 runtimeAnalysisData.variants / variantOrders；已发布显示版本不含这份完整数据。
- 既有 /api/runtime-analysis-data 先授权 projectId，并核对完整 ASIN 集合，站点取授权项目。正文来自 xydc-variants、xydc-orders 及独立属性翻译 JSON 缓存。
- 缓存有站点、输入 ASIN、父子集合、窗口、来源时间；没有 organizationId/projectId/runId/jobId 正文绑定。任务进度有批次身份，不能拿进度冒充正文归属证明。
- 当前缓存 reader 将缺文件、坏 JSON、schema 和 IO 错误都折叠成空数组。导出前应给已有读取链路补严格错误状态，区分无结果与读取失败。
- 待用户确认是否按“授权项目范围内现有页面共享缓存”导出，并明确缓存来源/时间而不声称属于已发布运行批次。确认前没有实现或开放第二模块。
- 若接受该口径，完整性检查须覆盖规范化 families、orderFamilies 和属性译名内容，不能只比较 fetchedAt。导出展示当前页面选定窗口的全部子体和 12 个月，不只前三条卡片、不把缓存所有历史窗口混入正文。
