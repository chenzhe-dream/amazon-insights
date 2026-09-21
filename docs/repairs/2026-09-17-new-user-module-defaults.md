# 新用户默认模块实施与验收（2026-09-17）

## 最终业务规则

- 入口：用户与使用统计 → 模块可见性 → 新用户默认模块。
- 用户确认：新增模块自动加入配置列表，由管理员勾选是否默认开放。
- 用户补充本地账号后续多数停用，仅保留管理账号：本次仅对首次创建的钉钉账号应用默认快照；本地账号、初始化管理员及通用账号创建保持原有行为，不删除任何账号。
- 已有用户、个人配置和再次登录不重新套用默认设置。新用户初始设置会显示“注册时默认配置”，个人修改后显示“已单独配置”。
- 系统所有者保持全部模块；用户统计等功能继续校验原有资格。模块可见不等于授予接口访问权限。
- 未设置默认值的组织保持初始九模块基线；基线是冻结兼容值，未来新增模块不会自动加入。允许管理员显式保存空列表。

## 实现

1. `shared/module-visibility-contracts.ts` 的 MODULES 统一提供选项、类型、校验和总数，移除 max(9) 与界面 /9。
2. `0054_new_user_module_defaults.sql` 新增组织级策略表，并在个人配置增加来源和默认版本。旧迁移未改写。
3. 策略更新使用组织事务锁、版本冲突检测和审计。钉钉创建在原账号事务内等待同一锁、读取默认值并写快照；快照失败则账号和身份均不提交。
4. GET/PUT `/v1/admin/module-visibility/defaults` 接入既有管理资格、组织隔离、Web 代理和公开契约；静态 defaults 路径不会被个人 userId 路径误匹配。
5. 抽屉覆盖读取/保存失败、取消、清空、冲突后重新读取、保存期间重复操作防护、键盘焦点和手机宽度。
6. 只读独立审查完成；最初发现的本地账号编辑缺口，依据用户明确范围收窄为“本地账号不套用策略”，对应扩展已撤销。

## 通过的验证

- 37/37 相关 Node 测试通过：新用户默认、个人可见性、契约注册、静态代理路径、钉钉身份和管理鉴权。
- 真 PostgreSQL 隔离数据库：迁移可重复执行、组织隔离、默认版本并发冲突、创建与策略更新锁等待、快照失败整笔回滚、重登不覆盖、空默认、新模块不自动开放、本地账号保持现状。
- Playwright + Vite + 真 PostgreSQL/真实后端路由烟测通过：默认设置保存/取消/冲突/失败/清空；原人员搜索、分页、个人和批量修改；桌面与手机；菜单与直达地址；专有统计资格保持。
- `npm run typecheck` 通过。
- 修改范围 ESLint、tracked diff whitespace 检查、OpenSpec strict 校验通过。
- 已人工查看桌面与手机截图：`.superpowers/sdd/new-user-module-defaults-desktop.png` 和 `new-user-module-defaults-mobile.png`。

相关测试命令：
```powershell
npx tsx --conditions=react-server --test tests/agent/new-user-module-defaults.test.ts tests/agent/module-visibility-store.test.ts tests/agent/module-visibility-contracts.test.ts tests/agent/module-visibility-proxy.test.ts tests/agent/postgres-dingtalk-auth-repository.test.ts tests/agent/user-presence-access.test.ts tests/agent/contracts.test.ts
npx tsx tests/smoke/module-visibility.ts
npm run typecheck
openspec validate add-new-user-module-defaults --strict
```

## 扩大回归发现的既有不一致

不是全仓测试全部通过。此次范围外有两项待单独处理：
- `postgres-core-repository.test.ts` 凭据撤销用例期望禁止环境回退，而当前 `connector-credential-service.ts` 的 `getSafeState()` 会回退环境配置。该服务无本次改动，HEAD 已包含当前实现；此文件 11 项通过、1 项失败。
- `primary-admin-page.test.ts` 的 Sorftime 零评论文案用例与当前页面输出不一致；此文件用普通 tsx 条件运行时 6 项通过、1 项失败。涉及市场/VOC 既有页面，本次未改。
- 旧钉钉绑定只读查询测试通过原始 SQL 修改组织，与新建快照的既有组织外键冲突；已改用 legacy 无快照 fixture 测其只读绑定语义，没有放松数据库约束或引入跨组织迁移功能。

## 后续模块接入要求

- 新父模块在 MODULES 登记 key 和中文 label；默认与个人配置列表、数量及后端校验自动同步。不要把新 key 加入 INITIAL_NEW_USER_MODULES。
- 新页面在 TabId 与 `app/lib/module-visibility.ts` 的映射中声明所属模块；子页面继承父模块。新增业务接口仍须自己的业务授权。
- 管理员进入“新用户默认模块”决定是否开放。已有账号的配置不会自动扩张，需按人员单独调整。
- 回归测试会模拟只增加注册项，验证 schema 能接受新模块且初始默认值不自动包含它。

## 发布状态

本地验收后，用户明确授权“直接发布”，已通过正式发布管理器完成构建、受管重启和精确版本激活。未调用真实模型或付费数据接口。

### 正式发布核验

- 时间（UTC）：2026-09-17T07:56:19.521Z。
- Web artifact：`5e3e2f9bd57c0dc43b2a183976d6e8a0fcb7f0dede248c7938c2d8acae1d96f7`。
- 前后端 sourceHash：`b95c40795d9951435d86a6ba3386671a6ba69ccbf4c8c78e74017423983f523c`，一致。
- PostgreSQL 迁移 0053、0054 已应用，服务本机与局域网健康均 HTTP 200。发布前后七类任务队列均为 0。
- 10 份已有个人模块配置的相关字段散列、正式配置文件散列均与发布前一致；原业务 artifact、jobVersion 与各阶段散列完整保留。
- 管理页 HTTP 200，正式提供的 `/assets/admin-users-page-BgYsxkk8.js` 包含新用户默认模块 UI 和 defaults 接口；未登录访问 defaults 返回 401。
- Chrome UI 自动化读取两次超时，未声称完成正式登录后点击验收；本地真实后端浏览器烟测已在上节记录。登录后最终业务验收由用户进行。
- 发布校验脚本首次将发布前 data-only 的 current 与缺省 dataCurrent 错比，核查确认旧 current 在代码发布后原样成为 dataCurrent；修正比较对象后全部通过，未改变任何业务数据。
- 证据：`.superpowers/sdd/module-defaults-release.log`、`module-defaults-release-before.json`、`module-defaults-release-after.json`。
- 验收入口：`http://192.168.1.109:31900/admin/users` → 模块可见性 → 新用户默认模块。
