# VOC Input Data Gaps Design

## Goal

修复两条已由源码和回归现象证明的 P0 输入可信度缺口：Alexa VOC 的跨 ASIN 执行身份冲突，以及 Sorftime `0/0` / ready-empty 脏缓存造成的评论数据假就绪；其余缺口只做只读分类，不凭未知 Provider 响应猜测适配器。

## Scope and non-goals

本变更只覆盖：

1. Alexa 显式 ASIN 不匹配在任何加密、快照、任务或模型调用前失败；标准化 fingerprint 同时绑定 marketplace、可信 ASIN、原文哈希和执行身份；防御性 worker 分类不再把输入 ASIN 冲突记为 persistence。
2. Sorftime rating 缓存复用先经过当前 catalog 正值冲突校验；评论 ready-empty 只有在当前、同 marketplace、同 ASIN、可信 `reviewCount === 0` 证据仍成立时才可复用；UI 显示该状态说明，并明确评论矩阵是独立 Sorftime 来源。
3. 对 B074 `product_reviews` 的 `MCP_SCHEMA` `boundary=tool-content` 以及其余缺口建立只读 inventory。没有脱敏后的实际响应 shape 证据，不改 MCP transport、Sorftime consumer adapter 或 Provider 调用参数。

不新增服务、表、迁移、stage、Provider 调用或架构层；不修改任何生成数据文件；不调用真实 Provider；不部署、推送、重启或发送真实 POST。

## Evidence in the current code

- `server/services/manual-alexa-voc-service.ts` 在严格解析失败后直接进入 `#queueNormalization`；`tryProcessReport` 将显式 ASIN 不匹配降为 `null`，因此错误输入仍会排队。
- `createAlexaVocNormalizationFingerprint` 当前只包含原文哈希和执行身份。`alexa-voc-normalization` 使用 stage-input lineage，同一 run/stage 中不同快照若共享 fingerprint，会在 AgentRun 身份比较处冲突。
- `canonicalizeAlexaVocNormalizationOutputRecord` 直到模型返回后才调用 ASIN 校验，并抛出普通 `Error`；worker 的默认分类是 `persistence`。
- `scripts/build-sorftime-rating.mjs` 在第一个 catalog 冲突判断之前复用任何 ready 缓存，因此 ready `rating=0, reviewCount=0` 可永久绕过现有冲突校验。
- `scripts/build-sorftime-review-analysis.mjs` 会无条件复用 ready 缓存；一旦生成 ready-empty，即使 rating 证据不再是可信零评论，也会在正常路径和 Provider 失败兜底中继续复用。
- `app/page.tsx` 只在非 ready 状态显示 `statusMessage`。ready-empty 在六个维度中被渲染成通用“暂无匹配主题”，丢失“已确认评论数为 0”的真实原因。
- `server/connectors/mcp-transport.mjs` 的 `tool-content` 表示首个文本块无法解析为 JSON；现有安全诊断只保留 shape=unknown。该证据不足以确定 B074 需要哪种 consumer adapter。

## Design

### Alexa trusted input identity

把现有原文 ASIN 扫描提升为可复用、类型化的 domain guard。请求完成 schema 校验和项目/run 授权后，立即用 trusted marketplace/ASIN 校验原文；无显式 ASIN 的报告仍允许绑定到所选 ASIN，出现任一不同显式 ASIN 时抛出专用 mismatch 错误。路由把它稳定映射为 HTTP 422、`ALEXA_VOC_ASIN_MISMATCH`，且响应不包含原文或候选 ASIN。

fingerprint 输入扩为 `{ marketplace, asin, rawReportSha256, executionIdentity }`。入队与执行期重新计算必须调用同一函数、传入快照的 marketplace/ASIN，保证不同 ASIN 永不共享标准化执行身份，同时保留同 ASIN、同原文、同执行配置的幂等复用。

canonical renderer 继续执行相同 guard 作为纵深防御。worker 识别类型化 mismatch 并归为 `schema`，而 repository/连接类错误继续保留原有 persistence/infrastructure 语义。正常 mismatch 因已在入队前拒绝，不应产生 terminal 记录。

### Sorftime evidence-aware cache reuse

rating 复用谓词必须在 `shouldUseCachedRecord` 之外再验证记录 scope，并对当前 catalog 正评分或正评论数否决缓存 `0/0`。主循环、无 key 可用性判断和 Provider 失败后是否保留缓存都使用同一谓词，避免任一路径绕回脏缓存。

review 复用谓词区分有样本 ready 与 ready-empty。`sampledReviews === 0` 且无 blocks 的 ready-empty 只有在当前 rating 记录同时满足同 ASIN、同 marketplace、ready、数值型 `reviewCount === 0`、合法 `fetchedAt` 且不与 catalog 正值冲突时复用。该谓词同样用于启动可用性检查、循环 cache hit 和失败兜底。若证据失效且没有 key，阶段保持失败/缺口；有 key 时走现有受治理 Provider 路径，不增加调用次数或重试。

UI 对 ready-empty 的空单元格优先显示 `statusMessage`，不再伪装成一般无主题。评论矩阵说明明确“独立 Sorftime 数据源，不继承上方 Alexa VOC”，保留现有 badge 和来源脚注。

### Evidence gate for all other gaps

实现期生成只读 inventory，逐项记录 ASIN、stage、operation、failure kind、cause code、boundary、可信输入证据、是否能由本地 fixture 重现、结论。B074 当前结论固定为 `hold/provider-evidence-required`。只有 inventory 中能由确定证据和本地 fake fixture 证明的代码缺陷，才允许另起设计/计划；本计划不含条件式代码修改。

## Error and safety behavior

- Alexa mismatch 是确定性的调用方输入错误：422 + `ALEXA_VOC_ASIN_MISMATCH`，零快照、零 job、零模型/Provider 调用。
- Alexa fingerprint 冲突修复不改变数据表、公开成功响应或幂等范围之外的执行行为。
- Sorftime 失效缓存只是不再被视为可信 ready；脚本不删除历史生成文件，也不在测试中写仓库的 `app/*-data.ts`。
- 所有脚本回归使用临时目录和本地 fake HTTP server；禁止真实 endpoint、真实凭据和真实 POST。

## Test strategy

先写失败测试。Alexa 覆盖 fingerprint 维度、同 run 两 ASIN 同文不共享身份、显式 mismatch 的 422 安全响应、入队/模型计数均为 0，以及 worker 防御性分类。Sorftime 覆盖 rating `0/0` 被 catalog 正值失效、review ready-empty 在证据失效后的 cache miss/失败兜底、可信零评论仍零 Provider 调用，以及 UI 呈现 statusMessage 和独立来源文案。最后运行定向测试、TypeScript 编译、build、敏感/真实调用静态检查与 `git diff --check`。

## Acceptance criteria

- 同一 run 中不同 trusted ASIN 即使 raw report 相同，也得到不同 fingerprint；显式 mismatch 在入队前返回 422 `ALEXA_VOC_ASIN_MISMATCH`，测试中的 Provider 调用数为 0。
- 输入 mismatch 不再以 persistence terminal 类别出现；防御性 worker 路径归类为 schema。
- catalog 存在正评分或正评论数时，ready `0/0` rating 缓存不能命中。
- ready-empty review 仅在当前可信零评论证据下命中；证据失效后不得在正常路径或 catch 兜底永久复用。
- 页面显示 ready-empty `statusMessage`，并明确评论矩阵是独立 Sorftime 来源。
- B074 与未证实缺口不产生 adapter 或调用参数改动。
