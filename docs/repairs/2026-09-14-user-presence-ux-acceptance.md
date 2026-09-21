# 用户状态优化与自定义账号清理验收

2026-09-14，本地已启用。用户确认清理对象为截图中的历史 ops-* / test-* 自定义账号，不按数据库“禁用”状态筛选。

## 页面

- 统一蓝白界面，增加人员总数、近期活动、从未登录概览与状态筛选。
- 默认显示钉钉人员；可搜索姓名/账号、切换活动状态和账号来源。
- PostgreSQL 后端分页，10/20/50 人；跨页搜索、稳定排序、页码校正。只为本页人员读取最近 10 次登录详情。
- 列表精简为人员、活动状态、角色、最后活动、最后登录、操作；登录记录点击展开。
- 刷新失败保留上次结果并提供重试；手机改为人员卡片，390px 下没有页面横向溢出。
- 用户状态 / 使用统计标签与 URL 同步，保持原钉钉认证与查看权限。

入口：http://192.168.1.109:31900/admin/users?view=presence

## 已执行账号清理

精确限定当前组织以及历史种子账号邮箱，排除钉钉绑定。备份后在事务内逐账号锁定并扫描指向 users 的外键。

| 处理 | 数量 | 账号 |
|---|---:|---|
| 删除无关联账号 | 7 | Ops Admin 2、3；Ops Member 1–5 |
| 停用归档，撤销会话 | 7 | Ops Admin 1、Ops Member 6、Test Admin、Test Member 1–4 |

归档的原因：部分账号关联项目、分析运行、VOC 修订、反馈或审计记录，直接删除会丢失或破坏历史。归档后不能登录，并从新旧用户状态接口中移除，历史关联保留。

核对结果：未归档的 ops-* / test-* 账号 **0**；未撤销的归档账号会话 **0**。原 **6 个钉钉用户**保持启用。系统 Admin 与 Local VOC operator 保留；它们不属于本轮 ops/test 清理名单。

迁移 0049 为 users 新增 archived_at，约束归档账号必须停用；SQLite 同步迁移。没有删除分析、VOC、反馈、审计或统计记录。

备份：C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/presence-before-20260914.dump，5,844,576 字节，pg_restore --list 验证通过。执行清单：.superpowers/sdd/presence-cleanup-applied.json。

## 验证

- 全仓 npm run typecheck 退出码 0，零诊断：presence-types-final.log。
- PostgreSQL 分页、跨页搜索、空结果、账号来源、组织隔离与归档隐藏：presence-page-green.log（1 项，修复前返回 24 人而非 10 人，已记录失败）。
- 清理事务预览、无引用删除、有引用归档、钉钉排除、跨组织排除、重复执行：presence-cleanup-test.log（1 项）。
- 浏览器分页、搜索、筛选、展开、20 人切换、刷新失败恢复及手机布局：presence-ux-browser.log（1 项）。
- 原状态/鉴权/PG/SQLite/统计存储回归首次 34 项中 33 通过。旧断言期望忽略伪造组织参数；新接口严格拒绝此参数，已更新断言且保留服务端组织归属校验，完整路由文件 14 项全部通过：presence-routes-final.log。
- 浏览器到真实隔离 PostgreSQL 的状态搜索与原统计模块联调：presence-usage-smoke.log，PASS。没有向正式数据库写入模拟用户或统计。

桌面和手机组件截图（合成测试数据）：.superpowers/sdd/presence-desktop.png、presence-mobile.png。

## 本地运行

通过现有 manage-formal-stack.ps1 -PublishCode 构建并启用，沿用原 PostgreSQL 58258。Web 31900、Agent 31901 健康，迁移 0049 已应用。

Web、Agent 与当前工作树源码指纹一致：a438a933a6b2a12f0122e838672e375393f1dba6b2da21ed36ff17e13e874fe3。日志：presence-local-update.log。修改尚未提交，未推送或发布到外部服务。
