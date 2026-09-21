# 模块可见性实施计划

目标：按已绑定的钉钉人员配置九个模块显示/隐藏；不改业务 API 授权、分析引擎和任务队列。

实现：原 PostgreSQL 增加个人可见模块配置；既有专用管理资格控制配置读写。登录会话返回配置，前端统一映射导航、子页面与快捷链接。无配置继承原显示范围，空数组表示全部隐藏。

- [x] 共享模块目录和协议；测试空列表、默认值与子页面映射。
- [x] PostgreSQL 配置/审计、人员搜索分页、现有资格校验；隔离数据库验证跨组织拒绝、钉钉身份限定、并发保存版本冲突。
- [x] 配置管理视图、保存取消；会话读取、菜单过滤、旧链接及快捷入口显示判断。配置入口独立于用户统计显示开关，避免管理员隐藏统计入口后无法再次配置。
- [x] 两种人员配置浏览器验证、原统计与页面回归、全仓类型检查；备份、构建、受管本地更新。

文件范围：shared/module-visibility-contracts.ts；server/db/postgres/module-visibility-store.ts；server/routes/module-visibility.ts；认证会话及仓库接线；app/lib/module-visibility.ts；app/admin/users/module-visibility-panel.tsx；现有导航/用户管理页面。迁移仅增加配置表，不写入任何人员的显示限制。
