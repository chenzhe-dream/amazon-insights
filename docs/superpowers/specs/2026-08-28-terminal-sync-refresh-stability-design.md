# 终态同步刷新稳定性设计

## 目标与边界

本切片只解决同步页在任务已经结束后仍持续轮询、每秒重渲染和重复应用相同状态的问题。实现基线固定为 `codex/stabilize-resumable-sync-pipeline` 的 `882aa01604d3020bb2df4f8445d05395dfcc81bd`。

运行中的 `queued`、`running`、`base-ready`、`enriching` 任务继续使用现有 1.5 秒 job GET 轮询和 1 秒倒计时。终态任务只有在 job、publication 与所需 stage output 都收敛后才静默；静默后不再保留这两个定时器。

本切片不改变同步任务创建、显式续跑、Provider、阶段执行、持久化合同、并发治理或 VOC 行为；不处理 VOC Positive/Negative 合并，不新增 SSE/WebSocket，不部署，不操作正式运行目录、任务、桌面 Chrome、31900/31901/58258 或 PostgreSQL。自动收敛路径只允许 GET，不产生 POST、`window.location.reload/replace/assign`、router refresh 或其他全页导航。服务器受控替换 Web 子进程仍属于既有 publication 流程，不等同于浏览器全页 reload。

## 方案记录

采用已批准的方案 A：保留运行期流式轮询，在终态使用共享收敛门禁并有界补齐 stage output，随后停止轮询与计时。

不采用“看到终态立即停止”，因为可能遗漏尚未落定的 publication 或最后一个 stage output；不采用“终态继续永久轮询”，因为永久缺失会造成无界请求和重渲染；不采用页面自动 reload，因为它破坏 GET-only 恢复合同并可能重复整个页面生命周期。

## 收敛模型

### 1. 两层门禁

共享的纯判定首先计算 `contentReady`：

- job 状态是 `completed`、`completed-with-gaps` 或 `failed`；
- 当前 job 中所有“所需 stage”都已解析为持久化 data、持久化明确 gap，或浏览器有界重试耗尽后的 `missing-output` 展示缺口；
- 所有已取得输出均通过 organization/project/run/job/stage 作用域、stage 状态、单调 outputVersion 与 contentHash 校验。

“所需 stage”是当前 job 的 stages 中，ID 属于既有 projectable stage 集合且状态为 `done`、`partial` 或 `failed` 的项。`pending`、`active`、`manual`、`skipped` 和非 projectable stage 不凭空要求 stage-output。

浏览器静默门禁为：

`quiescent = contentReady && publicationSettled`

`publicationSettled` 只接受 `applied`、`failed` 或服务端明确返回的 `not-required`。canonical job 中 publication 缺失不等同于 settled；服务端必须用 `not-required` 表达无需发布，避免浏览器猜测。

服务器 publication 复用同一个 `contentReady` 的持久化子判定：终态 job 的每个所需 stage 必须已有可核对的 data/gap 与 content hash，request、artifact、job scope 和版本必须一致，才允许替换 Web。服务器不能复用包含 `publicationSettled` 的完整浏览器门禁，因为 applied/failed 正是 publication 的输出；这一区分消除循环依赖。未满足持久化门禁的请求不得替换 Web，并按既有安全错误归并为 publication `failed`，不能永久停在 `pending`。

### 2. stage-output 结果语义

每次 stage-output GET 必须返回或归类为四种客户端结果之一：

- `applied`：新的、合法且单调的投影已进入可见快照；
- `resolved-unchanged`：响应合法，但与已接受的 outputVersion/contentHash 相同；该 stage 已收敛，不需要再次 setState；
- `retryable-missing`：网络错误、暂时未找到、响应不完整或暂时无法通过一致性校验；
- `missing-output`：有界预算耗尽后的客户端展示缺口。

`resolved-unchanged` 不得继续占用重试预算。publication、message 或其他 job 元数据推进 jobVersion 时，较早生成但仍是服务端当前权威结果的 stage projection 不得仅因 jobVersion 较小而被判为永久陈旧；投影仍须满足当前 scope、stage 终态、单调 outputVersion 和自校验 contentHash，且不得来自未来 jobVersion。后续显式续跑若产生更高 outputVersion，则按新投影正常替换。

每个所需 stage 在首次终态观察时立即请求一次，失败后最多再随两个 1.5 秒 job 周期重试，即每个 `(scope, jobId, stage, terminal episode)` 最多三次。第三次仍为 `retryable-missing` 时，客户端记录只用于展示的 `missing-output` 缺口，保留其他已验证模块并把该 stage 视为浏览器侧已收敛。它不得伪造持久化 `StageOutputProjection`、contentHash 或成功数据，也不得写回服务端。只有用户明确续跑原任务形成新的 terminal episode，才重置该 stage 的预算。

### 3. 状态与定时器

轮询处理顺序固定为：校验 job scope → 计算唯一观察 → 解析所需 stage output → 计算门禁 → 最后决定继续或停止。

对有合法 jobVersion 的 canonical job，状态观察键为 `(jobId, jobVersion, status, canonical publication)`；publication 使用稳定字段值而非对象引用比较。相同观察不得重复调用 job `setState`、terminal callback 或 artifact 收敛逻辑。无 jobVersion 的 legacy 响应不套用该去重键，避免抑制其真实进度变化。

在 `quiescent` 之前，现有 1.5 秒 job GET 负责推进 job、publication 和待补齐 stage output；现有 1 秒 clock 只服务倒计时展示。应用最后一个唯一观察并得到 `quiescent` 后，同一生命周期内同步清除两个 interval、登记 job 已完成，并且只触发一次对应的 complete/terminal callback。组件卸载、scope/job 切换和登出仍立即清理 interval、in-flight ownership 与旧 scope 快照。

publication 为 `pending` 时，即使 job 已终态且 stage output 已收敛，job GET 仍继续；1 秒 clock 也按批准方案保留，直到 publication 由服务器明确变为 `applied` 或 `failed`。服务器必须把每个 publication 请求有界归并为这两个状态之一。stage output 已形成 `missing-output` 后不得因后续相同 job/publication 响应重新开启预算。

## 页面与发布行为

终态收敛只局部更新同步组件及已验证模块。publication `applied` 且浏览器当前 artifact 不同，只显示既有安全提示，由用户决定是否手动刷新；本切片不自动导航。动态 stage output 继续保留在当前页面，publication `failed` 或 `missing-output` 只显示对应明确缺口，不清空成功模块、不自动重分析、不创建新 job/run/stage。

服务器在 runner 已持久化全部所需 output/gap 并把 job 置为终态后，才提交或消费 publication request。artifact 与 request 必须携带同一 jobId、可核对的 jobVersion 和完整 stageContentHashes；任何缺失、错配或非终态快照都 fail-closed，不替换当前健康 Web。该顺序确保浏览器所见终态、服务器发布内容与静默判定使用同一份持久化事实。

## 验证设计

实现阶段使用隔离的无头浏览器与 fake timers/受控响应，不使用桌面 Chrome 自动化或鼠标，并覆盖：

1. 四种运行态持续保持 1.5 秒 job GET 与 1 秒倒计时；重复的 `(jobVersion,status,publication)` 不产生 job setState。
2. `completed`、`completed-with-gaps`、`failed` 分别在 publication `applied`、`failed`、`not-required` 且输出均为 data/gap 时，两个 interval 都被清除，terminal callback 恰好一次。
3. publication `pending` 时不提前停止；服务器成功或失败后进入 settled，页面随下一次唯一 GET 观察静默。
4. stage-output 前两次暂缺、第三次成功时采用结果；三次均缺失时显示 `missing-output`，保留其他模块并停止继续请求该 stage。
5. 合法但未变化的 stage output 被归类为 `resolved-unchanged`，publication-only jobVersion 变化不会形成无限重试或重复 setState。
6. 自动收敛全程 job/stage-output 仅有 GET，浏览器全页 reload/navigation 与 POST 均为零。
7. 服务器拒绝非终态、缺少投影、hash/version/scope 不匹配的 publication；只对通过共享持久化门禁的 artifact 执行一次受控替换，并把结果归并为 applied 或 failed。

## 自审结论

文档没有未决项或占位符。浏览器完整静默门禁与服务器 publication 子门禁的关系已明确，避免用 publication 的结果作为其自身前置条件；三次 stage-output 尝试、legacy 去重例外、`not-required` 语义和自动导航禁令均为单一解释。范围仅含终态刷新稳定性及其服务器发布门禁，不包含 VOC Positive/Negative 合并、生产代码、测试执行、部署、Provider、任务或正式运行环境操作。
