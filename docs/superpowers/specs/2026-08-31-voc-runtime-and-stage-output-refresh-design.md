# VOC 状态、局部缺口与运行时数据刷新设计

## 目标

修复同一批验收页面中的四类误导状态：不存在的 VOC 阶段被显示为持续运行、未录入 VOC 时仍可启动分析、局部缺口被渲染成整模块失败、同步结束后正式 Web 仍展示启动前数据。

## 已确认根因

1. `observeVocRun` 在找不到 `voc-positioning` 阶段时把状态默认成 `queued`，因此任意基础同步 `run` 都会被误判为 VOC 正在运行。
2. 当前正式配置未启用 Manual Alexa VOC UI、写入和动态读取，也没有受保护的原始报告加密 keyring；三个新 ASIN 在 PostgreSQL 中均无 Manual Alexa VOC 记录。
3. 评论和 FBA 均为局部成功：当前批次各有 2/3 ASIN 可用；`StageOutputGapCard` 只展示整块缺口文案，掩盖了已成功数据。
4. 同步任务会改写 `app/*.ts` 生成数据文件，但正式 Web 的模块数据大多在构建时静态导入。`/api/catalog` 只动态刷新商品目录；partial stage 又不会把其成功子集投影到页面，所以任务完成后仍可能显示旧数据。

## 方案

### 1. VOC 状态必须由真实阶段证明

- 扩展浏览器观察结果为 `not-started | active | waiting-input | failed | succeeded | offline`。
- 查不到 `voc-positioning` 阶段且没有 VOC 报告时返回 `not-started`，不得轮询、不得显示运行中。
- 仅 `queued/running` 的真实 VOC 阶段可映射为 `active`。
- 基础同步 `runId` 不得恢复成 VOC 任务。

### 2. VOC 启动门禁与中文反馈

- 页面按当前 ASIN 集合显示 `VOC 数据已准备 N/总数`。
- 未达到全量录入时禁用“开始 VOC 独立分析”，并列出缺少的 ASIN；不得产生 POST。
- 启用既有受保护 Manual Alexa VOC 录入路径：正式配置仅开启 UI、写入和动态读取，并生成不回显的加密 keyring。legacy fallback 与 publication 保持关闭。
- 配置缺失、数据缺失及提交失败统一使用中文业务文案，不显示 `Manual Alexa VOC UI is disabled` 等内部英文错误。

### 3. 局部缺口按 ASIN 展示

- 取消评论/FBA的大面积“整模块失败”卡片。
- 改为紧凑状态条，明确成功数量、总数量、缺失 ASIN 与安全原因，例如：`评论数据 2/3；B0CSYXYWDZ 连接失败`。
- 已成功 ASIN 的数据继续正常渲染；100% 仅代表执行结束，数据完整度必须单独显示。

### 4. 运行时数据刷新

- 增加同源、已认证的运行时数据读取接口；只返回请求的当前 ASIN，并复用现有生成文件解析器，不暴露文件路径或其他项目数据。
- 接口覆盖页面当前依赖的 catalog、reviews、rating、sales trend、FBA、listing、category、keywords；traffic 继续使用既有 PostgreSQL snapshot 接口。
- 页面首次进入工作区、同步终态且 stage outputs 已收敛时各读取一次；使用响应替换对应运行时 source state，不进行周期性整页刷新。
- `done` stage 的权威 output 优先于运行时生成快照；`partial` stage 使用生成快照中的成功子集，同时保留 ASIN 级缺口提示。
- 请求失败时保留当前已验证数据并显示一次中文提示，不清空页面、不循环刷新。

## 安全与边界

- 不新建分析任务，不自动重试 Provider，不更改 SellerSprite/SIF/Sorftime 合同。
- 不把 Sorftime 自动替代 Manual Alexa；该能力另设切片。
- 运行时接口必须复用现有认证，普通用户只能读取自身可访问项目；不得返回 cookie、token、凭据、原始 Alexa 报告或文件系统路径。
- 保留当前 15 个 generated app 文件与项目 JSON WIP，不纳入功能提交。

## 验收

1. 基础同步 run 不含 VOC 阶段时，页面显示“尚未开始”，且停止轮询。
2. 0/3、2/3 VOC 时按钮禁用且没有 POST；3/3 时可提交一次真实 VOC 分析。
3. 评论/FBA 2/3 时展示两份数据和一个 ASIN 级缺口，不出现整模块失败卡。
4. 同步完成后无需重新构建或重启 Web，新生成数据在当前页面可见；刷新同一工作区后仍可见。
5. 运行时读取失败不会导致闪烁、循环刷新或清空旧数据。
6. 定向测试、受影响测试、lint、production build 与受控部署门禁通过。
