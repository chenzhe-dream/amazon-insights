# 模块三原版 UI 收拢验收

## 范围

按用户确认的方案保留查询、关键词表、五维综合结论、W1–W5、需求簇、分类参考主流程。人工分类和历史报告改为按钮展开的独立面板，关闭保留草稿；没有人工历史时不显示空历史卡片。管理员通过独立核对入口查看来源、逐词证据、严格规则和事实版本。任务管理默认隐藏，采集摘要、刷新和失败处理入口保留。评分和开发建议默认折叠。

只调整前端展示与入口；未改 API、数据库、采集规则或评分公式。管理员入口是 UI 角色边界，不代表新增服务端字段级权限。

## 验证

- 新增入口与报告分离测试先失败再通过；最终相关回归 39/39 通过，类型检查通过。
- 浏览器验证人工草稿关闭重开保留、任务恢复、历史读取、失败重试及角色差异。
- 正式构建、受控发布成功，Web 31900 / Agent 31901。
- 发布代码 `cf82834094af32f5bdbcfa2c347027c95e243381`。
- 正式健康接口 source/release hash 一致：`671bade7a695b72f9dd362489f6eabd3b38410beb835fff27aa61f6ad4bec443`。
- Artifact `6518b257726458fbfc8ad6fc42f267bd6160aa2b1608a95c88240590d6fc7d33`。
- 回滚分支 `codex/rollback-before-keyword-ui-20260928`，原代码 `d256942e4d3afc36758b4d2ab2bb2a6c9bf37303`。
- 使用临时成员和管理员账号登录实际项目入口，读取真实任务 `41702503-2d36-4571-ac21-d652342c6667`。两角色均显示 100 词、8 需求簇；成员无管理员入口，管理员可展开核对；主页面编辑器和空人工历史卡片隐藏，评分默认折叠。
- 打开和刷新前后采集步骤 attempt 完全相同，无报告写请求、无浏览器异常。临时账号已停用、会话已撤销。
- 已查看正式成员主页面、五维结论、人工入口和管理员核对截图；手机版未列入本次范围。

## 本地证据

- `test-results/keyword-ui-final-regression.log`
- `test-results/keyword-ui-typecheck.log`
- `test-results/keyword-ui-publish.log`
- `test-results/keyword-ui-online.log`
- `test-results/keyword-ui-online-20260928/result.json`
- `test-results/keyword-ui-online-20260928/member-main.png`
- `test-results/keyword-ui-online-20260928/member-summary.png`
- `test-results/keyword-ui-online-20260928/admin-audit.png`

人工编辑能力保留，未在正式环境提交或修改用户分类；保存、草稿和版本恢复行为由本地浏览器回归验证。
