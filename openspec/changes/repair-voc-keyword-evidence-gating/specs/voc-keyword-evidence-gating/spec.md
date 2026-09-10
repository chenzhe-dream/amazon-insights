## Purpose

确保 VOC 与关键词联合定义仅使用当前授权范围内、可追溯且已固定版本的真实证据。系统明确区分已保存手工 VOC、用户启用的评论兜底、输入缺口、持久任务状态与历史版本，避免未执行分析就显示最终产品结论。

## ADDED Requirements

### Requirement: Scope-bound input inventory

系统 SHALL 只读展示当前授权项目、站点及所选 ASIN 的输入清单，逐 ASIN 标记手工来源、可用评论、维度缺口、源版本、采集时间和指纹。所选 ASIN MUST 为项目 ASIN 的非空子集，范围与分母 MUST 明确，客户端传入的来源内容或跨项目版本不得替代服务端授权读取。

#### Scenario: One product is selected from three
- **WHEN** 用户从三件竞品中只选择一件
- **THEN** 输入与报告范围为所选一件，显示 1/1，不声称三件资料齐备，不修改原项目名称或 ASIN 列表

#### Scenario: Scope mismatch or logout
- **WHEN** 请求包含另一项目、组织、站点的来源，或用户退出登录及切换会话
- **THEN** 服务端拒绝越权来源，页面清除当前范围观察状态，旧请求迟到不得显示为新范围结果

### Requirement: Valid manual evidence takes precedence

系统 SHALL 优先使用已保存、标准化成功、非模拟、与范围及截止时间匹配且含实质主题内容的手工 VOC。草稿、排队、运行、失败及仅状态字段 MUST NOT 视为可用证据。来源优先级 MUST 按 ASIN 和有证据维度判断。

#### Scenario: Manual normalization is incomplete
- **WHEN** 文本已粘贴但尚未保存或标准化仍运行
- **THEN** 清单显示缺口，手工就绪数量不增加，不生成联合成功结果

#### Scenario: One of three manual records is valid
- **WHEN** 一个 ASIN 有有效手工 VOC，另外两个只有有效评论
- **THEN** 保留第一个 ASIN 的手工主来源，并仅在明确启用兜底后使用其余评论；显示手工 1 个、评论兜底 2 个

### Requirement: Explicit review fallback

系统 SHALL 仅在用户点击“使用评论兜底分析”或明确更新兜底报告时启用评论。默认运行策略 MUST 为手工优先且不启用评论。兜底记录 MUST 含有效具体主题与可追溯来源；仅 ready、评分、样本数、空主题及全局构建期数据不能放行。缺失维度 MUST 保留缺口，不按固定评论数量阈值制造可信度。

#### Scenario: Empty review content is marked ready
- **WHEN** 手工为零且评论 status 为 ready 但 blocks 为空或所有 rows 为空白
- **THEN** 评论不可用于兜底，系统等待输入，不提交分析

#### Scenario: Valid reviews exist without manual VOC
- **WHEN** 无手工但有有效评论及关键词，用户尚未点击兜底按钮
- **THEN** 页面展示可用兜底及缺口，零业务 POST、零模型调用、零联合成功报告

#### Scenario: User explicitly enables fallback
- **WHEN** 用户点击兜底且服务端重新校验输入未变
- **THEN** 创建一次持久任务，结果标为“评论兜底版·待手工 VOC 验证”，手工完成率仍按真实手工覆盖计算

#### Scenario: Sources conflict
- **WHEN** 已有手工主题与允许使用的评论主题相冲突
- **THEN** 保留双方证据与独立分母，结论标待验证，不静默覆盖或合并百分比

### Requirement: Keyword and output boundaries

系统 SHALL 区分关键词 ready、合法 empty、failed 与 missing。只有有效 VOC 与有效关键词均存在且实际联合阶段成功后，才能显示联合产品定义。缺关键词时 MUST 保留已完成 VOC 分析并暂停无证据联合判断；只有关键词时 MUST 仅展示需求候选。缺证据不得默认 D，不得伪造证据 ID、市场规模或最终 A 级立项。

#### Scenario: Missing or empty or failed keywords
- **WHEN** VOC 可用但关键词分别为 missing、合法 empty 或 failed
- **THEN** 分别显示未获取、当前范围无有效关键词或请求失败，保留 VOC，联合判断待输入，无默认机会等级

#### Scenario: Only keyword evidence exists
- **WHEN** 关键词有效但无有效手工或评论
- **THEN** 显示关键词需求候选并等待 VOC，不创建成功联合定义

#### Scenario: Both inputs are absent
- **WHEN** 无 VOC 且无关键词
- **THEN** 等待输入，零成功报告，零机会等级

#### Scenario: Single-source matrix row
- **WHEN** 一条主题只有 VOC 证据或只有关键词证据
- **THEN** 可表达对应单源待验证判断，缺失侧为空且不伪造 ID；双重验证判断要求两侧都引用本次可信输入

### Requirement: Persisted report is authoritative

系统 SHALL 从当前授权运行读取真实持久报告，分别表达执行状态、来源模式、覆盖和新鲜度。前端本地规则计算 MUST NOT 代替未完成、失败或不存在的联合报告。未知版本或缺来源清单的旧报告 MUST 仅作为历史展示。

#### Scenario: Backend is queued or failed
- **WHEN** 后台未生成当前联合报告，即使前端存在若干 VOC 或关键词数据
- **THEN** 页面显示等待或真实失败，不提前展示最终定义、等级或模拟成功内容

#### Scenario: Completed fallback task
- **WHEN** 评论兜底任务真实完成
- **THEN** 可显示执行完成，同时持续标评论兜底版及证据缺口，不转换为标准版或手工就绪 100%

### Requirement: Version-safe explicit updates

系统 SHALL 固定本次源 snapshot/report ID、手工 revision/generation、来源时间和内容指纹。补填手工或更新来源后旧报告 MUST 保留历史并标待更新；仅用户明确更新时重跑相关分析阶段。旧任务迟到 MUST NOT 覆盖较新输入的当前报告。

#### Scenario: Manual VOC changes after fallback
- **WHEN** 兜底报告完成后用户保存新的有效手工版本
- **THEN** 旧报告标待更新、保留原证据；读取不重跑，明确更新后使用新手工主来源且不重抓整批竞品

#### Scenario: Inventory changes between preview and submit
- **WHEN** 点击时输入已不同于显示的指纹
- **THEN** 返回输入已变化，刷新只读清单并要求用户再次点击，不静默分析新的来源集合

### Requirement: Read-only hydration and safe execution

页面打开、刷新、切换页面、读取失败或缓存失效 SHALL 只进行读取，不自动创建业务任务。明确提交 MUST 幂等且保留既有五分钟 deadline、租约和权限校验。模型失败 MUST 保持真实失败与可重试提示。

#### Scenario: Double click and reload
- **WHEN** 用户双击分析按钮后刷新
- **THEN** 双击只发送一次创建请求，服务端重复同键请求返回同一运行；刷新只 GET 并恢复该运行

#### Scenario: Failed update with history
- **WHEN** 新版本执行失败且存在旧版报告
- **THEN** 当前状态保持失败、旧版明确标历史，不能因为历史报告存在就显示当前成功

#### Scenario: Deadline or late response
- **WHEN** 五分钟超时、取消或切换范围后旧调用返回
- **THEN** 保留超时/取消及新范围状态，旧响应不得更新当前结果
