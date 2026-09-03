# 生成数据发布与页面呈现修复设计

## 目标

在保留现有“运行 MCP → 写入生成数据文件 → 构建 Web 包”架构的前提下，确保本次 ASIN 的数据只有在新 Web 包已经启动并通过健康检查后才触发页面刷新。刷新后页面必须稳定呈现已生成的数据，不得出现固定延时过早刷新、循环刷新或重新调用 MCP。

本设计是当前跑通目标的最小修复。服务端事件流（SSE）、运行时快照接口和断线轮询兜底延后实施。

## 当前问题

现有流程为：

1. 同步任务调用 MCP，并把结果写入 `app/*.ts` 生成数据文件。
2. 同步任务执行生产构建，写入 Web reload request。
3. Supervisor 异步消费 request、替换 Web 进程并检查健康状态。
4. 同步任务先结束并返回 `needsReload=true`。
5. 页面看到终态后固定等待约 2.5 秒执行 `window.location.reload()`。

第 4、5 步没有等待第 3 步真正完成。页面可能在旧 Web 仍提供旧构建包时刷新；随后终态 tombstone 又会阻止同一任务再次自动刷新，最终形成“后端数据已生成，但页面仍为空”的假完成状态。

## 范围

### 本次包含

- 给 Web 发布流程增加可查询的确认状态。
- 只有新 Web 进程通过健康检查后，发布状态才可变为成功。
- 页面等待发布成功后只刷新一次。
- 刷新后继续保留同一 `syncJob` 指针和终态结果。
- 构建或 Web 切换失败时显示固定中文错误，不得把任务显示为数据已呈现。

### 本次不包含

- SSE、WebSocket 或逐模块流式推送。
- PostgreSQL 运行时业务数据快照。
- 改写现有 MCP 数据解析与生成文件格式。
- 重新调用 SellerSprite、SIF、Sorftime、图片 AI 或 Alexa VOC。
- 为解决本问题重构整个同步任务系统。
- “重新发布数据”的管理员恢复动作；该能力放到页面稳定呈现后的第二阶段。

## 发布状态模型

同步任务的公开响应新增封闭的 `publication` 对象：

```ts
type SyncPublication =
  | { status: "not-required" }
  | { status: "pending"; requestId: string; requestedAt: string }
  | { status: "applied"; requestId: string; requestedAt: string; appliedAt: string; artifactId: string }
  | { status: "failed"; requestId: string; requestedAt: string; failedAt: string; code: "WEB_PUBLICATION_FAILED" };
```

约束：

- `requestId` 是当前 reload request 的稳定标识。
- `artifactId` 是构建开始前生成的非敏感唯一标识。它必须同时写入构建产物清单、Web 健康响应和页面根节点的 `data-web-artifact-id`，用于证明 Supervisor 与浏览器运行的是本次构建，而不是旧 Web 实例。
- API 不返回主机路径、命令行、原始异常、环境变量或密钥。
- `needsReload` 在兼容期可保留，但前端不得再仅凭它安排固定延时刷新。

发布 acknowledgement 文件是 `applied`/`failed` 的权威来源。同步任务镜像只保存当前 generation、`requestId`、`artifactId` 和 requestedAt；任务查询接口按 requestId 读取 pending、processing、applied、failed 四个受控目录并投影公开状态。Supervisor 不与 Runner 并发改写整份任务镜像。

## 数据流

1. MCP 阶段结束后，Runner 写入生成数据文件。
2. Runner 生成 `artifactId`，把它注入本次生产构建，并执行一次构建。
3. Runner 写入 reload request；request 必须绑定 `jobId`、`requestId`、`artifactId` 和目标 worktree。
4. 同步任务公开状态变为终态，同时 `publication.status=pending`。页面显示“数据已生成，正在发布到页面”。
5. Supervisor 原子领取 request，启动候选 Web 进程。
6. Supervisor 仅在以下条件全部满足后写入成功确认：
   - 候选 Web 进程仍存活；
   - Web 健康接口返回成功；
   - 健康接口报告的 `artifactId` 与 request 完全一致；
   - 目标 worktree、host 和 port 与受控配置一致。
7. Supervisor 原子写入 applied acknowledgement。若切换失败，则恢复旧 Web，并写入固定失败 acknowledgement。
8. Agent 的同步任务查询接口根据 acknowledgement 返回 `publication=applied|failed`。确认记录是发布状态的权威来源，不依赖浏览器计时。
9. 页面轮询到 `applied` 后记录“已为该 job/artifact 安排刷新”，然后只执行一次刷新。
10. 新页面加载后再次查询同一任务；因为当前页面的 `artifactId` 已等于 publication 的 `artifactId`，所以直接呈现数据并停止刷新。

## 前端状态与交互

终态展示分为两层：

- 业务同步状态：`completed` 或 `completed-with-gaps`，继续如实展示各 ASIN/模块是否 ready。
- 页面发布状态：`pending`、`applied` 或 `failed`。

页面规则：

- `pending`：保留完整进度卡，显示“数据已生成，正在发布到页面，请勿重复提交”。继续 GET 同一任务，不 POST。
- `applied` 且当前页面 `artifactId` 不一致：只安排一次页面刷新。
- `applied` 且当前页面 `artifactId` 一致：显示“数据已发布”，停止发布轮询，正常呈现生成数据。
- `failed`：显示“数据已生成，但页面发布失败”，保留业务结果和缺口列表；不得自动重新调用 MCP。
- 刷新、断网恢复或重新打开带 `syncJob` 的 URL 后，继续查询同一任务并恢复上述状态。
- 用户点击“收起”只收起展示，不改变任务或发布结果。

为了防止循环刷新，浏览器的终态记录必须绑定 `(jobId, artifactId)`，不能只绑定 `jobId`。只有页面实际运行的 artifact 与已应用 artifact 不一致时才能刷新。

完整方案的发布轮询采用固定节奏：前 30 秒每 1 秒 GET 一次，随后 90 秒每 2 秒 GET 一次；超过 120 秒后显示“发布时间较长，请联系管理员”，并降为每 5 秒 GET 一次。MVP 可复用现有 1.5 秒任务 GET 间隔，以减少改动。任意时刻得到 `applied` 或 `failed` 后立即停止轮询。该过程不得产生 POST。

## 后续发布失败恢复（不在本次 MVP）

主界面为管理员提供“重新发布数据”动作。它只能：

1. 校验原任务属于当前组织、项目、市场和 ASIN 范围；
2. 校验原任务已经是业务终态，且没有活动 Worker/lease；
3. 使用现有生成数据重新执行一次构建和受控 Web 发布；
4. 创建新的 publication request，并增加 publication generation；
5. 不修改 ASIN 模块结果，不调用任何 MCP，不创建新的 sync job/run/stage。

同一 generation 的重复点击必须幂等复用，不得产生并行构建。失败响应只使用固定错误码和中文提示；原始构建输出仅留在本机受控日志中。

## 兼容与迁移

- 现有没有 `publication` 且 `needsReload` 不为 true 的历史任务按 `not-required` 处理，不自动刷新、不自动重建。
- 现有 `needsReload=true` 且能找到 applied acknowledgement 的任务，可投影成 `publication=applied`。
- 现有 `needsReload=true` 但没有 acknowledgement 的终态任务显示“历史任务发布状态未知”，由管理员显式选择重新发布；不得自动调用 MCP。
- 现有终态 URL 恢复、scope 校验、一次提交和 tombstone 规则继续保留。
- SSE 第二阶段接入后可以替换 publication 轮询，但本状态模型和确认记录继续复用。

## 错误处理

- 构建失败：业务数据保留；任务返回发布失败，页面不刷新。
- 候选 Web 启动失败：Supervisor 恢复旧 Web，发布失败。
- 健康检查返回错误 artifact：视为发布失败，禁止把旧 Web 标记为 applied。
- acknowledgement 临时不可读：页面保持 pending 并按既定节奏退避轮询，不推测成功。
- Agent 查询暂时失败：页面使用退避 GET，保留已有进度和数据，不清空界面。
- 超过发布等待上限：页面显示“发布超时，请联系管理员”；服务端最终状态仍由 acknowledgement 决定。

## 测试

### 后端与 Supervisor

- request 必须绑定正确 job、worktree、target 和 artifact。
- 新 Web 健康且 artifact 匹配时才写 applied。
- 健康失败、进程退出或 artifact 不匹配时恢复旧 Web并写 failed。
- applied/failed acknowledgement 写入原子且重复消费幂等。
- 公开任务响应严格过滤内部字段。
- 第二阶段的“重新发布数据”必须不调用 MCP、不创建新业务任务，并对重复请求幂等。

### 浏览器

- publication pending 持续 GET，同一期间 POST 为 0。
- pending 期间不会按固定 2.5 秒提前刷新。
- applied 后只刷新一次；新页面 artifact 匹配后不再刷新。
- 刷新后仍保留同一 `run` 和 `syncJob`，已生成数据可见。
- completed 与 completed-with-gaps 都遵守相同发布规则。
- failed 显示固定中文错误，并且不会清空已知业务进度。
- 断网恢复、页面刷新、重复挂载均不会形成刷新循环。

### 回归

- 用户一次点击仍只创建一个业务同步任务。
- SellerSprite、SIF、Sorftime 的成功、降级和缺口语义不变。
- 图片 AI 和 Alexa VOC 行为不变。
- 现有管理员恢复失败阶段不被“重新发布数据”替代或混淆。

## 验收标准

- MCP 生成数据后，页面最终呈现与生成文件一致的数据。
- 页面不会在发布确认前刷新。
- 一次业务任务最多因一个 publication generation 自动刷新一次。
- 页面刷新后不再出现“后端有数据、前端仍为空”的状态。
- 发布失败不会触发新的 MCP 请求，也不会伪装为数据已呈现。
- 正常发布路径无需用户手动刷新或重启服务。
