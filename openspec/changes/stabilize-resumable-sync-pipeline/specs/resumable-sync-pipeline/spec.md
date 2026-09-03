## Purpose

为局域网业务中的 ASIN 数据同步提供可恢复、可去重、局部失败透明且不干扰正式服务的稳定行为，并用 traffic 垂直切片证明 PostgreSQL 数据可以无需重新构建前端而动态可见。

## ADDED Requirements

### Requirement: 同步任务具有可恢复的稳定身份
系统 SHALL 以服务端认证组织、项目标识或明确的无项目作用域、marketplace 以及排序去重后的 ASIN 集合构成同步任务作用域，并为每个任务返回稳定 jobId。客户端 MUST 将当前 jobId 保存在 URL 中；已有 jobId 时只能读取该任务，除非用户明确发起新同步。

#### Scenario: 页面刷新恢复原任务
- **WHEN** 用户刷新包含有效 jobId 的同步页面
- **THEN** 客户端只 GET 原 job 并恢复轮询，不再次 POST 同步请求

#### Scenario: 浏览器关闭后 Worker 继续
- **WHEN** 用户在任务处于 active 状态时关闭浏览器或离开页面
- **THEN** 后台 Worker 继续执行，稍后使用同一 jobId 可读取最新状态

#### Scenario: URL 中任务与当前作用域不一致
- **WHEN** URL jobId 对应的组织、项目、marketplace 或 ASIN 集合与当前页面不一致
- **THEN** 客户端不得采用该任务或自动 POST，并提示用户显式开始当前作用域的新任务

### Requirement: 相同 active 同步请求防重复
系统 MUST 对相同任务作用域的并发启动请求执行幂等处理。当已有 `queued`、`running`、`base-ready` 或 `enriching` 任务时，系统 SHALL 返回已有 jobId 和复用标志，且不得创建第二个任务文件或第二个 Worker。

#### Scenario: 一秒内重复提交
- **WHEN** 两个请求并发提交相同组织、项目、marketplace 和 ASIN 集合
- **THEN** 两个响应返回同一 jobId，只有一个后台 Worker 被启动

#### Scenario: ASIN 顺序不同
- **WHEN** 两个请求只在 ASIN 输入顺序上不同
- **THEN** 系统将其识别为同一规范化集合并复用 active job

#### Scenario: 旧任务已经终态
- **WHEN** 同一作用域的最近任务已为 `completed`、`completed-with-gaps` 或 `failed`
- **THEN** 用户显式重新同步时系统创建新的 jobId，并保留旧任务供审计与恢复查看

### Requirement: 基础数据优先于图片增强
系统 SHALL 先处理 catalog，再处理关键词、评论、销量、子体销量、价格策略、FBA、Listing、类目和 traffic 等基础模块；traffic MUST 在图片备注之前达到终态。基础模块均已成功或已记录明确局部缺口后，系统 SHALL 宣布基础页面可用，并允许图片备注继续后台执行。Alexa VOC MUST 保持 manual，且不得阻塞基础页面可用或同步任务终态。

#### Scenario: 图片备注仍在运行
- **WHEN** traffic 与其他基础模块已经达到终态而图片备注仍在处理
- **THEN** 页面可展示已有基础报告与 traffic，任务显示 `base-ready` 或 `enriching`

#### Scenario: Alexa 尚未录入
- **WHEN** 一个或多个 ASIN 的 Alexa VOC 尚未人工录入
- **THEN** 对应状态显示 `manual`，基础同步仍可完成或以局部缺口完成

#### Scenario: 基础模块部分失败
- **WHEN** 某个基础模块对单个 ASIN 失败但其他基础结果已可用
- **THEN** 系统发布可用结果并把任务标为有缺口，不等待图片备注或把全部结果判为失败

### Requirement: 图片失败按单图和单 ASIN 隔离
系统 SHALL 使用有上限的小并发处理图片备注，并为每张图片设置独立超时。单图失败 MUST 只影响该图片及所属 ASIN 的图片备注状态，不得阻塞其他 ASIN、traffic、基础发布或整个 Worker 的终态化。

#### Scenario: 单图超时
- **WHEN** 一张图片达到单图超时上限
- **THEN** 该 ASIN 的图片备注状态显示 `timeout`，其余图片和 ASIN 继续处理

#### Scenario: 图片连接器失败
- **WHEN** 图片分析连接器对一个 ASIN 返回失败
- **THEN** 该 ASIN 显示 `connector-failed`，已成功的基础数据与其他 ASIN 的图片结果保持可用

#### Scenario: 图片上游没有可分析内容
- **WHEN** Listing 已成功但上游没有可分析图片
- **THEN** 该 ASIN 的图片备注状态显示 `upstream-empty`，而不是 `ready` 或通用任务失败

### Requirement: 逐 ASIN 数据状态真实可见
系统 SHALL 为每个 ASIN 的每个同步模块公开且持久化 `ready`、`upstream-empty`、`timeout`、`connector-failed`、`pending` 或 `manual` 之一，并允许阶段聚合为 partial。系统 MUST 区分合法空结果、超时和连接器失败，不得把部分成功伪装为完整成功，也不得因单 ASIN 失败覆盖其他 ASIN 的成功结果。

#### Scenario: 评论连接器只对一个 ASIN 失败
- **WHEN** reviews 对一个 ASIN 返回连接器失败，而同批其他 ASIN 已成功
- **THEN** 失败 ASIN 显示 `connector-failed`，成功 ASIN 显示 `ready`，reviews 阶段显示 partial

#### Scenario: 上游明确返回空结果
- **WHEN** 连接器成功响应但目标 ASIN 没有该模块的数据
- **THEN** 该 ASIN 显示 `upstream-empty`，任务可进入 `completed-with-gaps`

#### Scenario: 错误包含敏感内容
- **WHEN** 上游或子进程错误包含请求头、凭据、代理或数据库连接信息
- **THEN** 持久化状态、日志与客户端响应只包含清理后的有限诊断信息

### Requirement: 正式 supervisor 独占 Web 刷新权
同步 runner MUST NOT 启动、停止或重启任何 Web 服务器，也不得调用会打开旧 3000 黑框或创建旧防火墙规则的脚本。需要发布构建期数据时，runner SHALL 在构建成功后提交受控 reload 请求；正式 launcher/supervisor SHALL 是唯一可替换当前 Web 子进程的组件，并只使用已配置的正式 Web 端口。

#### Scenario: 同步 build 成功
- **WHEN** 基础数据构建成功且需要让构建期数据在页面可见
- **THEN** runner 提交 reload 请求而不派生 Web 进程，supervisor 受控替换当前 31900 Web 子进程

#### Scenario: supervisor 暂不可用
- **WHEN** 构建成功但正式 supervisor 无法消费 reload 请求
- **THEN** 系统保留构建结果和待发布状态，不得回退启动 3000 或第二套 Web

#### Scenario: 普通数据刷新
- **WHEN** supervisor 刷新当前 31900 Web 子进程
- **THEN** 31901 Agent 与 58258 PostgreSQL 保持运行，进行中的后台采集不因浏览器或 Web 子进程替换而被取消

### Requirement: 已应用 Web artifact 的浏览器收敛最多自动一次
系统 SHALL 仅在终态任务的所需 stage output 已收敛、`publication.status=applied` 且目标 `artifactId` 合法时，允许已打开的旧页面自动加载已应用 artifact。自动动作 MUST 先持久化绑定认证组织、项目、marketplace、规范化 ASIN 集合、jobId 与 artifactId 的一次性 claim；同一绑定跨重复回调、Strict Mode、tab 切换与 remount 最多发生一次完整页面导航。恢复 MUST 保留原 `run` 与 `syncJob`，且只 GET 原任务；自动路径不得创建 job、run、stage，不得 POST 同步或调用 Provider。

#### Scenario: 已应用 artifact 与当前文档不同
- **WHEN** 终态任务的 stage output 已收敛、publication 为 applied，且当前文档 artifact 与合法目标不同
- **THEN** 浏览器先持久化该 scope/job/artifact 的一次性 claim，再保留现有 URL 身份并最多自动导航一次
- **AND** 新文档只 GET 原 `syncJob`，不得重新提交分析

#### Scenario: 当前文档已经是目标 artifact
- **WHEN** 当前文档 artifact 等于 publication 的目标 artifact
- **THEN** 浏览器不自动导航，删除仅用于 cache-bust 的临时 `webArtifact` marker，并正常呈现已发布数据

#### Scenario: 已 claim 后仍未收敛
- **WHEN** 同一 scope/job/artifact 已执行过一次自动导航，但新文档仍未报告目标 artifact
- **THEN** 浏览器停止所有后续自动导航并显示“新数据已发布，请手动刷新”
- **AND** 重复挂载与轮询继续保持 POST=0、Provider=0、新 job/run/stage=0

#### Scenario: publication 不允许自动收敛
- **WHEN** publication 为 pending、failed、缺失，artifactId 非法，或终态记录无法安全持久化
- **THEN** 浏览器不得自动导航或推测发布成功；pending 继续 GET，其他情况保留安全提示与既有业务结果

### Requirement: traffic 使用 PostgreSQL 动态读取 tracer
对于具备授权 projectId 和 runId 的同步任务，系统 SHALL 将成功采集的 traffic 快照写入 PostgreSQL，并提供按认证组织和 run 作用域读取的动态接口。页面 SHALL 优先使用与当前 run、marketplace 和 ASIN 集合匹配的 PostgreSQL traffic 快照；仅在不存在可用动态快照时使用迁移期 legacy fallback。

用户从 canonical project 显式启动不依赖 VOC 的基础自动分析时，系统 SHALL 在同一同步启动临界区创建或复用同步专用 canonical run。该 run MUST 只由现有 sync job 驱动一个 `traffic-analysis` stage，不得 enqueue 通用 analysis Worker；页面 URL、sync job 和 traffic snapshot MUST 使用同一 projectId/runId。同步专用 run/stage MUST 随 traffic 与 sync job 结果进入可解释终态，不得留下无 stage 或无法闭合的 run。

#### Scenario: 基础自动分析创建同步专用 run
- **WHEN** 已认证用户在 canonical project 明确点击“开始全自动分析”且同 scope 没有 active job
- **THEN** 系统创建一个同步专用 run 和唯一 `traffic-analysis` stage，创建一个携带该 projectId/runId 的 sync job，并且不创建通用 analysis Worker

#### Scenario: 同 scope 重复提交
- **WHEN** 等价的明确提交在第一个 sync job 仍 active 时到达
- **THEN** 系统返回相同 runId/jobId，且 Worker claim 数仍为一；页面不得创建第二个 run

#### Scenario: 同步专用 run 闭合
- **WHEN** traffic 快照成功、明确局部失败、基础设施失败或任务取消
- **THEN** `traffic-analysis` stage 与 run 分别进入对应的 succeeded、partial、failed 或 cancelled 终态，页面可继续按 sync job 展示其他模块缺口

#### Scenario: traffic 快照成功写入
- **WHEN** traffic 连接器为有作用域任务返回有效结果
- **THEN** 系统持久化带来源、采集时间、marketplace、ASIN 集合和 run 关联的 PostgreSQL 快照，并将相关 ASIN 标为 `ready`

#### Scenario: 页面读取新 traffic 数据
- **WHEN** PostgreSQL 中出现当前 run 的新 traffic 快照
- **THEN** 已打开页面通过动态接口读取并显示它，无需执行前端 build 或重启 31900

#### Scenario: 用户访问其他组织的 run
- **WHEN** 用户请求不属于其认证组织的 traffic 快照
- **THEN** 系统返回不可见或未找到响应，且不泄露该 run 或快照是否存在

#### Scenario: 动态快照尚不存在
- **WHEN** 当前 run 没有可用 PostgreSQL traffic 快照
- **THEN** 页面可以显示明确的 pending/empty 状态或使用标注为 legacy 的已有静态数据，但不得把 legacy 数据宣称为本次新采集结果

### Requirement: 部署受业务安全门禁约束
系统变更部署前 MUST 确认没有 active sync job，定向测试和 fresh build 已通过，并选择业务空档。部署过程 MUST 保护当前 31900、31901 和 58258，不得输出 secret、token、数据库 URL 或完整 provider body。

#### Scenario: 有 active sync job
- **WHEN** 部署检查发现任一 `queued`、`running`、`base-ready` 或 `enriching` 任务
- **THEN** 部署暂停，运行中的 31900、31901 和 58258 保持不变

#### Scenario: 部署后真实 smoke
- **WHEN** 新版本在业务空档受控启动完成
- **THEN** 验收确认刷新保留同一 job、重复提交不产生第二个 Worker、traffic 不等待图片、局部状态可见且没有 3000 监听或黑框

#### Scenario: 正式启动误带 fake provider 模式
- **WHEN** 正式 launcher 检测到本地 fake provider 模式已启用
- **THEN** launcher 在创建任何 Web/Agent 子进程前拒绝启动，返回不包含环境值或秘密的安全错误；开发与测试 fixture 不受影响

### Requirement: 真实 provider 故障可诊断并安全降级
系统 SHALL 对真实 provider 调用保留有界、脱敏的诊断结果，并区分 DNS、TLS/CA、代理、连接、超时、HTTP、RPC、响应校验、合法空响应和资源治理拒绝。只有 provider 成功响应且通过 schema 校验的空结果才可标记 `upstream-empty`；传输或协议失败 MUST 标记为 `connector-failed` 或 `timeout`，不得被命令退出码或 readiness 后置检查覆盖。

当主 provider 路径不可用时，系统 MUST 停止该连接器的后续自动请求，保留 jobId、已成功数据和失败阶段，并向管理面板公开连接器与有限故障码。备用路径 MUST NOT 自动切换到 fake、legacy 或旧缓存并宣称为本次真实采集；provider 恢复后，只有管理员显式续跑才可从失败阶段重新提交，同一作用域仍只能存在一个 active Worker。

#### Scenario: detached runner 发生响应前网络失败
- **WHEN** 子进程在 DNS、TLS、代理或连接阶段失败且未收到 provider 响应
- **THEN** 对应 ASIN 模块显示 `connector-failed` 和脱敏故障码，任务保留为有缺口状态，不得显示为合法上游空数据

#### Scenario: provider 合法返回空结果
- **WHEN** provider 请求成功、响应通过 schema 校验且目标 ASIN 确实没有数据
- **THEN** 对应模块显示 `upstream-empty`，且诊断中不得伪造传输故障

#### Scenario: 主路径失败进入备用状态
- **WHEN** 某连接器达到本次任务的失败门槛
- **THEN** 系统停止该连接器的后续自动请求，保留其他模块结果并显示 `provider-degraded` 或等价明确状态，不自动重试、不重复计费且不注入假数据

#### Scenario: provider 恢复后显式续跑
- **WHEN** 管理员确认 provider 已恢复并对原任务执行续跑
- **THEN** 系统仅重新执行失败或未完成阶段，复用原作用域且只启动一个 Worker，已成功阶段不得被清空

#### Scenario: 诊断包含敏感字段
- **WHEN** 子进程错误携带 secret、请求头、代理凭据、数据库 URL 或完整 provider 地址
- **THEN** 持久化记录、日志、接口和管理面板只保留白名单故障类别与安全 cause code

### Requirement: 真实数据源可由最高管理员安全配置并验证
系统 SHALL 在管理面板分别展示 SellerSprite、SIF 与 Sorftime 的安全配置状态、配置来源、最近探测结果和有限故障码。只有最高管理员 MUST 能够保存、替换、撤销托管凭证或执行单次连接探测；托管凭证 SHALL 加密保存并优先于服务器环境变量，环境变量只作为不可读取、不可由页面覆盖或撤销的只读兜底。任何接口、页面、日志、缓存或测试证据 MUST NOT 回显凭证明文。

#### Scenario: 最高管理员保存托管凭证
- **WHEN** 最高管理员为一个连接器提交合法的新凭证
- **THEN** 系统加密保存新版本并只返回连接器、配置状态、版本和更新时间，页面输入框清空且响应不包含原值

#### Scenario: 普通管理员或成员修改凭证
- **WHEN** 非最高管理员尝试保存、替换、撤销或探测连接器凭证
- **THEN** 系统拒绝操作且不泄露该连接器是否存在托管凭证、环境变量值或历史秘密

#### Scenario: 使用服务器环境变量兜底
- **WHEN** 连接器没有 active 托管记录但服务器环境变量已配置
- **THEN** 管理面板显示“服务器已配置”的只读状态，页面不能读取、替换或撤销该值

#### Scenario: 最高管理员执行连接探测
- **WHEN** 最高管理员对已配置连接器点击测试连接
- **THEN** 系统执行一次有界最小探测，只返回健康状态或安全故障码，不创建 sync job、不写业务快照、不自动重试

### Requirement: 真实同步受连接器就绪门禁保护
系统 MUST 在创建真实同步任务前按所选自动阶段计算必需连接器，并在服务端验证每个必需连接器已配置、最近显式探测通过且未处于降级状态。任一条件不满足时系统 SHALL 拒绝创建 job；页面 MUST 指明需要处理的连接器，但不得显示秘密或自动探测、保存凭证、重试同步。

#### Scenario: 必需连接器未配置
- **WHEN** 用户启动真实同步而 SellerSprite、SIF 或 Sorftime 中任一必需连接器未配置
- **THEN** 系统不创建 job、不启动 Worker，并返回该连接器未就绪的安全提示

#### Scenario: 必需连接器探测失败
- **WHEN** 连接器已配置但最近显式探测返回连接、认证、协议或资源治理失败
- **THEN** 系统阻止新的真实同步并显示有限故障码，已保存的 job 与数据保持不变

#### Scenario: 所有必需连接器通过探测
- **WHEN** 所有必需连接器均已配置且最近显式探测通过
- **THEN** 系统允许用户明确启动同步，但配置或探测动作本身不得自动提交同步请求

### Requirement: 遗留错误空结果可离线预览并重分类
系统 SHALL 为诊断能力上线前的终态 job 提供最高管理员专用的离线修复。候选模块 MUST 同时满足：属于当前认证组织、生成于诊断版本前，并且没有成功 provider 响应或 schema-valid 空结果证据。系统 MUST 先返回不含秘密且带 job 版本的预览；只有管理员明确应用且版本仍匹配后，才把候选从错误 `upstream-empty` 重分类为 `pending` 与有限 `LEGACY_UNVERIFIED` 原因。缺乏证据时系统 MUST NOT 反向臆测具体连接器故障。修复不得调用 provider，不得删除或覆盖 ready/manual 结果、旧 attempt、生成文件或 PostgreSQL 快照。

#### Scenario: 预览遗留修复
- **WHEN** 最高管理员请求预览一个同组织终态 job 的遗留状态修复
- **THEN** 系统只返回将被重分类的 ASIN、模块、连接器和安全原因，不修改 job 或发起网络请求

#### Scenario: 应用遗留修复
- **WHEN** 最高管理员确认应用与预览版本一致的修复
- **THEN** 系统在预览版本仍匹配时原子重分类候选模块为 `pending/LEGACY_UNVERIFIED`，并保留 jobId、scope、attempt、成功数据、文件与快照，不创建 Worker

#### Scenario: 合法空结果或成功模块
- **WHEN** 模块具有成功响应、schema-valid 空结果、`ready` 或 `manual` 证据
- **THEN** 遗留修复不得修改该模块

#### Scenario: 预览后 job 已变化
- **WHEN** 最高管理员应用修复时 job 版本与预览不一致
- **THEN** 系统拒绝写入并要求重新预览，不覆盖并发产生的新状态

#### Scenario: 修复后显式续跑
- **WHEN** 管理员在连接器恢复后显式续跑已重分类的 job
- **THEN** 系统以 job 中的 `connector-failed`、`timeout` 或 `pending` 逐 ASIN状态选择目标，即使旧构建期占位文件存在也不得跳过，并继续复用原 scope 与单 Worker 门禁

### Requirement: SIF trend raw response 只在 adapter 边界白名单投影
系统 MUST 只从 `ops_get_asin_traffic_trend` raw object 提取 traffic 领域实际消费的官方字段并用现有有界合同严格验证。未消费的官方字段和供应方附加字段 MUST 在 adapter 边界丢弃，且不得进入领域模型、诊断、日志、快照或 content hash。系统 MUST NOT 使用 `passthrough`、`any` 或整个 raw object 的宽松持久化来绕过 schema drift。

#### Scenario: 完整官方对象带附加字段
- **WHEN** raw response 包含合法 `dates`、`nfScore/adScore` 或 `nf/ad`，同时包含其他官方字段和供应方附加字段
- **THEN** adapter 只生成原有 canonical monthly record，附加字段不被记录或持久化

#### Scenario: 核心 traffic 字段缺失或错型
- **WHEN** raw response 的核心月份或 score 数组缺失、错型、超长或包含非法元素
- **THEN** 系统继续以 `SIF_TRAFFIC_SCHEMA_INVALID` fail-closed，且不得创建 traffic snapshot

### Requirement: Listing 图册补齐后图片分析必须重新激活且恰好一次
系统 SHALL 把图册尚未就绪导致的 image remarks 空结果视为可重新评估状态。当同一 job 的 Listing 图册后来出现可分析图片时，系统 MUST 重新激活该 ASIN 的 image remarks 并且最多入队一次；只有图片分析完成后才发布对应图片备注终态。已 ready 的图片备注、重复恢复和并发恢复 MUST NOT 产生重复图像分析调用。

#### Scenario: 图册在首次图片检查后补齐
- **WHEN** image remarks 首次检查因无可分析图片未调用图像分析，随后 Listing 为该 ASIN 持久化可分析图册
- **THEN** 同一 job 重新选择该 ASIN、调用图片分析一次，并在结果持久化后发布 ready 或明确局部失败

#### Scenario: 重复或并发恢复图片阶段
- **WHEN** 两个恢复请求同时看到同一 ASIN 的图册已就绪且图片备注缺失
- **THEN** 只有一个恢复者取得执行权，另一方去重且不得产生第二次图片分析调用
