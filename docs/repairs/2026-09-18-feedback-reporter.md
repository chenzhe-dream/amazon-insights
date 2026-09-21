# 反馈管理展示提出人

反馈管理卡片在标题下显示「提出人：姓名」，管理详情同时展示账号。姓名为空时显示账号，历史记录缺失用户信息时显示用户 ID。我的反馈列表保持原有布局。

提交人继续使用反馈创建时服务端保存的 actorUserId，不新增可由提交者填写的身份字段。SQLite 和 PostgreSQL 查询按用户 ID 与组织 ID 关联 users，使用 LEFT JOIN 保留历史反馈。接口增加可选 actorDisplayName、actorEmail，兼容旧响应。不需要数据库迁移；姓名展示当前用户资料中的姓名。

验证：

- feedback.test.ts：8 项通过，包括提交、权限、组织隔离和数据库姓名读取。
- feedback-reporter.test.tsx 与 help-feedback-ui.test.tsx：7 项通过，覆盖姓名、账号、历史 ID 兜底和 HTML 转义。
- npm run typecheck 通过；反馈组件和上述测试文件定向 ESLint 通过。
- 以 PostgreSQL 只读连接执行修改后的 CoreStore 查询：现有 8 条反馈全部正确关联姓名，列表与详情均通过接口契约校验。未修改正式数据。

## 正式发布

用户随后授权发布，已通过 `manage-formal-stack.ps1 -PublishCode` 更新正式系统。发布前后七类任务队列均空闲。

- 正式 artifact：`fbfd59c561f6a5dea3608c14394eb6f9032f2e17cabd396734072cf18d934f75`。
- Web 31900、Agent 31901 及局域网健康检查全部 HTTP 200，前后端源码身份一致。
- 正式返回的 `page-oxt-DaTP.js` 和提出人样式与本机构建字节一致；确认包含提出人、提交账号，以及既有全屏和颜色展示功能。
- 27 份用户模块配置及正式配置散列保持一致，业务数据 artifact 未切换；PostgreSQL 只读复验 8 条反馈全部关联姓名。
- 发布证据：`.superpowers/sdd/feedback-reporter-release.log`、`feedback-reporter-release-before.json`、`feedback-reporter-release-after.json`、`feedback-reporter-release-assets.json`。
