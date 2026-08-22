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

### Requirement: traffic 使用 PostgreSQL 动态读取 tracer
对于具备授权 projectId 和 runId 的同步任务，系统 SHALL 将成功采集的 traffic 快照写入 PostgreSQL，并提供按认证组织和 run 作用域读取的动态接口。页面 SHALL 优先使用与当前 run、marketplace 和 ASIN 集合匹配的 PostgreSQL traffic 快照；仅在不存在可用动态快照时使用迁移期 legacy fallback。

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
