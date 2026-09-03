# 最高管理员管理中心与共享分析历史集成设计

**日期：** 2026-09-01
**状态：** 已确认，待并行实施
**集成基线：** `5bc7611657c69745775e8ddc351376a4bee4a9bf`

## 1. 目标

在不影响现有 VOC、关键词、同步流水线和业务数据的前提下完成两个独立切片：

1. 把现有用户活动状态页面优化为主应用统一风格的最高管理员管理中心；
2. 接入 PostgreSQL 权威分析历史，让历史记录不再依赖某个 worktree 的 `data/projects/*.json`。

两个切片并行开发、独立测试，最后在单一集成候选中做联合回归。SIF 密钥更换属于运行配置，不进入代码提交。

## 2. 最高管理员定义与权限

复用现有 `app/lib/primary-admin.ts` 语义。只有满足以下全部条件的已验证会话用户才是最高管理员：

- `role === "admin"`；
- 邮箱 trim、转小写后精确等于 `admin@example.com`；
- 账号与会话仍然有效。

最高管理员可读取账号状态和全部正式分析历史。普通管理员、member 与未认证请求均 fail-closed：页面不显示入口，直接调用 API 也返回 403 或 401。浏览器传入的邮箱、角色和 URL 均不能作为授权依据，服务端必须根据 session principal 与 repository 用户重新判定。

## 3. 切片 A：管理中心

- 保留 `/admin/users` 稳定地址，但页面外观改为主应用同一导航、卡片、色彩、间距和响应式布局。
- 在最高管理员主应用身份区增加明确的“管理中心”入口；管理中心提供“账号管理”和“分析历史”两个导航入口。
- 账号列表保留当前真实状态语义：近期在线、会话有效但近期无活动、从未登录、会话过期/撤销、账号禁用。
- 展示账号、显示名、角色、账号状态、登录次数、最后登录、最后活动、有效会话到期和最近登录记录；不展示 token、Cookie、密码、session id、IP、凭据或内部数据库字段。
- 普通管理员不再拥有账号看板读取权；原本仅按 `role=admin` 放行的 API 和页面必须收紧为最高管理员。

## 4. 切片 B：共享分析历史

- 以现有 `codex/shared-analysis-history-*` 实现为参考，只移植到当前基线所需的独立读模型、严格合同、repository、API 和 `/analyses` 页面，不直接合并旧基线的整条分支。
- 历史权威来源是 PostgreSQL/SQLite 现有 `projects`、`analysis_runs`、`run_stages`、`job_attempts`、snapshot 与 report；不以 legacy project JSON 作为历史权威来源。
- `/analyses` 展示每一次正式 run，而不是只展示项目当前 run；支持项目名、ASIN、创建者和状态检索，显示真实阶段进度、完整/部分/失败状态与报告入口。
- `/analyses/{runId}` 展示该 run 的项目、ASIN、阶段、attempt 安全摘要、snapshot/report 可用性和固定错误分类。
- 当前首页的本地工作区快捷入口继续保留；旁边增加“全部分析历史”入口。不得删除或覆盖任何本地项目、PG 项目、run、stage、snapshot 或 report。
- 本切片先实现只读历史验收；归档、恢复、永久删除等高风险写操作不纳入本轮快速集成，避免影响现有运行数据。

## 5. 当前历史缺失的确定原因

当前首页调用 `/v1/local-data/projects?kind=analysis`，数据来自当前 worktree 的本地 project store，并按 `analysis` 类型筛选。候选 worktree 只有两个对应快捷项目，因此页面只显示 Kick Scooters 和 Floor Lamps。

正式数据并未删除。设计冻结时 PostgreSQL 仍有 35 个项目、38 次分析运行和 38 个阶段记录，且活动 run 为 0。切片 B 将直接读取这些权威记录。

## 6. 并行边界与集成

### A 窗口只负责

- 最高管理员服务端授权；
- `/admin/users` 页面和管理中心外观；
- 账号状态 API/页面测试。

### B 窗口只负责

- 分析历史合同、repository、只读 API；
- `/analyses` 与 `/analyses/{runId}`；
- 历史列表、详情和权限测试。

### 主集成窗口负责

- 合并两侧提交；
- 统一处理 `server/app.ts`、授权分类、共享合同注册和主导航等交叉文件；
- 运行 focused、affected、lint、production build、OpenSpec strict 和联合权限回归；
- 启动本地候选供用户验收；用户确认前不 push。

## 7. 验收标准

1. `admin@example.com` 可从主应用进入管理中心，看到全部账号真实状态与全部正式分析历史。
2. 普通 admin、member、未登录用户看不到入口，直接访问/API 均 fail-closed。
3. 历史页能读到 PostgreSQL 中的历史项目与 run，不再只显示两个本地快捷项目。
4. 历史运行的 succeeded、partial、failed 和运行中状态真实显示，不把缺口伪装为完成。
5. 页面刷新只发送 GET，不创建新项目、job、run、stage，不调用 Provider。
6. 现有 VOC、关键词、批量 ASIN、同步进度和账号登录回归通过。
7. 本地测试通过后由用户验收；只有用户确认后才 push。
