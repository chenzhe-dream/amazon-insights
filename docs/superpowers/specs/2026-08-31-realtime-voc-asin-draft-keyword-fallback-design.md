# 实时 VOC、ASIN 草稿与关键词降级统一设计

**日期：** 2026-08-31

**状态：** 已批准，待实施
**目标分支：** `codex/stabilize-resumable-sync-pipeline`

## 1. 结论

本方案把当前三个相互影响、但必须独立交付和回滚的问题拆成三个严格有序的切片：

1. **先建立 PostgreSQL 运行时 Manual Alexa VOC 权威源。** 导入成功即持久化精确 UTC 时间、revision 和内容哈希；页面直接 overlay 最新记录；31901 每次运行按组织、站点、ASIN 与 run cutoff 动态读取。`app/rufus-voc-data.ts` 只保留为 legacy fallback，静态 Artifact 发布降为 best-effort，不再决定数据是否可见。
2. **再统一 `comparisonDraft`。** 编辑态允许 0–10 个 ASIN 自由增加、删除、替换和清空；只有保存或运行时才校验 3–10 个。默认另存为新组合，不覆盖历史项目或历史运行，并消除 `inputs`、`asinDraft`、`activeAsins` 三份状态错配。
3. **最后增加 SIF 关键词有界降级链。** 所有响应先过严格 schema；只对可识别的参数不兼容执行 allowlist 替代参数重试；其后可查询已验证的父体/主 Listing ASIN；最后只能显示明确标记的类目代理关键词。Sorftime 只作身份或趋势交叉验证，绝不能冒充目标 ASIN 的 SIF 流量。

三个切片共享组织、站点、ASIN、时间和来源证明语义，但不共享开关、提交或回滚单元。切片 2 依赖切片 1 提供稳定的“当前草稿 / 已提交运行”边界；切片 3 依赖切片 2 提供不可变的运行 ASIN 快照。实施不得跳过此顺序。

## 2. 目标

### 2.1 Manual Alexa VOC

- 导入接口返回成功后，同一页面无需等待构建、无需刷新服务即可在 VOC 核心矩阵看到本次七维数据。
- 页面刷新或重新登录后仍从 PostgreSQL 恢复动态 VOC，不依赖本地生成文件是否已发布。
- VOC 独立分析在点击运行时按该新运行的精确 cutoff 读取最新可见 revision，无需手工重启 31900、31901 或 58258。
- 已存在运行继续使用其不可变 cutoff 和 snapshot；新导入不得静默改写旧运行结果。
- 所有读取和写入都按 `organizationId + marketplace + asin` 隔离。
- 同内容重复提交幂等；内容变化生成单调递增 revision，并保留历史 revision 供 cutoff 回放。

### 2.2 ASIN 比较草稿

- 用户可从 0–10 个 ASIN 开始编辑，包括完全清空。
- 输入中的格式错误、重复项和不足 3 个只显示草稿诊断，不阻止继续编辑。
- “保存组合”“开始分析”“启动同步”在动作边界使用同一个不可变草稿快照，并统一校验 3–10 个合法且不重复的 ASIN。
- 草稿改变后默认创建新组合；旧项目、旧运行、旧 snapshot、旧报告保持不可变。
- 页面表格、保存按钮、运行按钮、URL 和同步任务不再分别读取不同的 ASIN 状态。

### 2.3 SIF 关键词降级

- 目标 ASIN 调用失败时按可审计、定额、有来源标签的链路继续尝试，而不是直接得到无解释空白。
- 严格区分目标 ASIN 数据、替代参数下的目标 ASIN 数据、父体/主 Listing 数据和类目代理数据。
- 无论哪一级成功，都保留 `targetAsin` 与实际 `queriedAsin` / `categoryId`，不得把父体或类目指标显示成子体自身流量。
- Sorftime 仅用于确认父子/主 Listing 身份、类目身份或交叉验证趋势；不得填充 SIF 的目标 ASIN 流量占比、自然排名或广告排名。

## 3. 非目标

- 不迁移、替换或重新选择 Alexa、SIF、Sorftime、SellerSprite 等 provider。
- 不自动抓取 Alexa，不绕过 Amazon 买家账号、浏览器插件或人工粘贴流程。
- 不删除、覆盖或批量重写任何历史项目、运行、snapshot、报告、静态 TS 数据、cache 或 Artifact。
- 不把父体评论或父体 VOC 当作目标子 ASIN 的 Manual Alexa VOC；父体回退只适用于 SIF 关键词证据，并必须显式标记。
- 不让后台 Artifact 发布重新成为 Manual Alexa VOC 的正确性门槛。
- 不在本切片中把所有现有文件型项目收藏迁移到 PostgreSQL；仅收紧新组合的不可变行为和执行注册边界。
- 不用 LLM 猜测缺失关键词、父子关系、类目或流量值。
- 不扩大支持站点；当前业务仍以 `US` 为首发站点，但合同和主键必须包含 marketplace。

## 4. 现状与根因

### 4.1 Alexa 导入后页面仍是旧矩阵

当前 `POST /api/alexa-voc/import` 在解析成功后调用静态写入，再触发后台重建。成功响应仅让导入面板显示预览和“后台发布”提示；它没有更新页面持有的 VOC 数据，也没有轮询 publication generation。

VOC 核心矩阵由 `app/page.tsx` 读取构建时打包的 `rufusVocData[p.asin]`。因此导入虽然已写入 cache 或生成源文件，当前 31900 Artifact 仍显示旧值，直到新 Artifact 构建、reload request 被 supervisor 应用且页面重新加载。

这解释了“导入显示 7/7，但核心表仍提示尚未提问”：导入写入和页面读模型不是同一个实时数据源。

### 4.2 31901 读取的是进程启动时静态对象

`RepositoryVocSourceReader` 的默认 Alexa source 来自静态导入的 `rufusVocData` 和 `rufusVocMeta`。31901 启动后不会因 31900 的 Artifact 更新而重新加载该模块，所以即使 Web 发布完成，`POST /v1/local-voc` 仍可能读旧对象。

同时，静态 meta 只有日期时，`normalizeRepositoryDateOnlyUtc` 会把它折算成当日 `23:59:59.999Z`。同日稍早创建的 run cutoff 会把本次记录判为 `after-cutoff`。这是“页面显示已写入，但 VOC 独立分析仍拿不到”的第二个根因。

### 4.3 Artifact 发布承担了不应承担的数据一致性责任

当前 cache、TypeScript 投影、publication state、不可变 Artifact、reload request 和 supervisor 应用形成一条长链。任一步延迟或失败，数据就不可见；但这些步骤本质上是静态兼容投影和 Web 发布，不应决定运行时业务数据是否存在。

### 4.4 ASIN 输入存在三个可变真相

`app/page.tsx` 同时维护：

- `inputs`：十个输入框；
- `asinDraft` / `asinParse`：概览批量输入；
- `activeAsins`：矩阵、保存和部分分析使用的活动 ASIN。

`replaceInputAsins` 只更新前两者；不同保存函数分别读取 `inputs` 或 `activeAsins`；`runAnalysis` 又按 tab 选择不同来源。项目 hydrate、URL hydrate 和同步恢复会分别更新这些状态。结果是用户看到的输入、保存下来的组合和实际运行的组合可能不同。

此外，`parseAsinsParam` 在少于 3 个时直接返回空，导致合法的“编辑中 0–2 个”无法作为草稿表示。现有 `ensureAnalysisWorkspace` 还会静默复用同 ASIN 集合的历史项目，与“默认另存新组合”和历史不可变要求冲突。

### 4.5 SIF 只有一次无来源层级的调用

`scripts/build-sif-keyword-analysis.mjs` 当前只调用一次 `market_get_asin_keyword_signals({ asin, country, time_type, time_value, listingSearch, topN })`。失败时保留旧缓存或写 `error`；没有参数兼容重试、父体/主 Listing 关系验证、类目代理或来源层级。

现有输出仅含一个 `asin`，无法区分“业务目标 ASIN”和“实际查询对象”。如果直接把 Sorftime 或父体结果塞回该结构，会把不同口径伪装为目标 ASIN 流量，产生比空数据更严重的错误结论。

## 5. 方案取舍

### 5.1 继续优化静态发布链

导入后等待 Artifact 构建完成，主动刷新页面，并让 supervisor 同时重启或热加载 31901。优点是数据库改动少；缺点是每次人工粘贴都绑定构建、两个进程的代码版本和 reload 成功，仍不能自然表达组织隔离、精确 cutoff 或历史 revision。该方案不采用。

### 5.2 PostgreSQL 权威源 + 动态读取 + 静态兼容投影（采用）

导入首先提交 PostgreSQL，页面和 31901 动态读取；现有静态 TS/Artifact 异步跟随。它同时解决即时矩阵、精确 capturedAt、组织隔离和无需服务重启，并保留 legacy fallback 和低风险回滚。代价是增加两张表、repository/API 合同和 UI overlay，但这些都是运行时数据应有的边界。

### 5.3 完全删除静态 VOC 与生成文件

页面和 31901 只读 PostgreSQL，立刻移除 `rufus-voc-data.ts`、cache 和 publication。长期最简单，但会一次性切断现有回滚路径，并涉及历史静态数据迁移/删除，超出本方案明确范围。该方案不采用；静态路径只降级为 legacy fallback。

ASIN 草稿方面，继续给三份 state 补同步 effect 只能增加竞态，选择 reducer 单一编辑真相；关键词方面，直接使用 Sorftime 或无标签父体数据会污染口径，选择严格 schema + 有界、带 provenance 的降级链。

## 6. 总体架构边界

```text
Browser / 31900
  ├─ comparisonDraft（纯编辑态，0–10）
  ├─ committedScope（项目/运行不可变快照）
  ├─ GET/POST /api/alexa-voc/*（同源 Web proxy）
  └─ static TS only as legacy fallback
              │ authenticated cookie forwarding
              ▼
Agent / 31901
  ├─ ManualAlexaVocService
  │    ├─ parser + strict normalized record schema
  │    └─ ManualAlexaVocRepository → PostgreSQL
  ├─ RepositoryVocSourceReader（按 org/marketplace/cutoff 动态读取）
  ├─ project/run lifecycle（不可变 ASIN scope + dataCutoffAt）
  └─ keyword fallback orchestrator（SIF primary, Sorftime verifier only）
              │
              ├─ PostgreSQL：权威运行时数据、revision、snapshot、run
              ├─ SIF MCP：关键词主证据
              └─ Sorftime MCP：关系/类目/趋势交叉验证

31900 background publisher
  └─ static TS / immutable Artifact / reload request（best-effort compatibility）
```

边界规则：

1. 31901 和 PostgreSQL 对 Manual Alexa VOC 的存在性、时间和历史 revision 负责。
2. 31900 负责用户交互、同源代理和即时 overlay，不自行认定组织身份，不自行生成权威时间。
3. 静态 TS 和 Artifact 是 legacy 兼容读模型，不是数据库的写前日志，也不是提交事务的一部分。
4. 草稿仅存在于当前浏览器编辑会话；一旦保存或运行，服务端以动作请求中的不可变 snapshot 为准。
5. SIF adapter 负责 provider 参数与严格响应映射；业务层只接收已经标注来源模式的规范记录。
6. Sorftime adapter 不得实现或返回 `target-asin-traffic` 类型。

## 7. 切片一：PostgreSQL Manual Alexa VOC 权威源

### 7.1 数据模型

新增两张表，并为 SQLite 测试后端和 PostgreSQL 正式后端分别增加**仅向前**的新迁移；不得改写已有 migration。

#### `manual_alexa_voc_heads`

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `organization_id` | text / FK 语义，非空 | 租户边界 |
| `marketplace` | text，非空 | 规范化大写站点 |
| `asin` | text，非空 | 规范化 10 位 ASIN |
| `latest_revision` | bigint，`>= 1` | 当前 revision |
| `latest_content_hash` | char(64)，非空 | 规范化七维 + 原文的 SHA-256 |
| `latest_captured_at` | timestamptz，非空 | 数据库事务内生成的精确 UTC 时间 |
| `updated_at` | timestamptz，非空 | head 最后变化时间 |

主键为 `(organization_id, marketplace, asin)`。

#### `manual_alexa_voc_revisions`

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `organization_id` | text，非空 | 租户边界 |
| `marketplace` | text，非空 | 站点边界 |
| `asin` | text，非空 | 目标子 ASIN |
| `revision` | bigint，`>= 1` | 每个 scope 单调递增 |
| `content_hash` | char(64)，非空 | 幂等与审计哈希 |
| `captured_at` | timestamptz，非空 | 本 revision 正式提交时间 |
| `normalized_record` | jsonb / SQLite text JSON，非空 | 经 `AlexaVocSnapshotRecordSchema` 等价 schema 校验的七维记录 |
| `raw_report` | text，非空，最大 128 KiB | 原始报告，用于审计与未来重新解析；列表接口不返回 |
| `created_by` | text，非空 | 当前登录 user id |
| `created_at` | timestamptz，非空 | 与 `captured_at` 相同事务时钟 |

主键为 `(organization_id, marketplace, asin, revision)`；增加 `(organization_id, marketplace, asin, captured_at DESC, revision DESC)` 索引。禁止覆盖或删除 revision。

`captured_at` 必须来自 31901 在事务内取得的数据库时间，并序列化为带 `Z` 的完整 ISO-8601；不能使用 `YYYY-MM-DD`、浏览器时间或文件 mtime。JavaScript 合同至少保留毫秒精度，数据库保留其原生更高精度。

### 7.2 哈希与幂等

内容哈希按以下 canonical payload 计算：

```json
{
  "marketplace": "US",
  "asin": "B0XXXXXXXX",
  "normalizedRecord": {},
  "rawReportSha256": "..."
}
```

JSON key 按稳定顺序序列化，数组保持解析器输出顺序，字符串使用既有规范化结果；hash 不包含组织、actor、时间或 revision。

写入事务对 head 行执行锁定：

- 没有 head：插入 revision 1 和 head。
- 新 hash 等于 head hash：返回当前 revision、原 `capturedAt` 和 `idempotent: true`，不插入 revision、不更新时间。
- 新 hash 不同：插入 `latest_revision + 1`，随后更新 head，返回 `idempotent: false`。
- 并发首次写入通过主键冲突重读并重试一次事务；并发更新按 head 锁串行化。

允许用户以后重新提交与更早 revision 相同的内容；只要它不同于**当前** head，就生成新 revision，表示一次明确回退。这样既保证网络重试幂等，也保留业务修订历史。

### 7.3 Repository 合同

新增 `ManualAlexaVocRepository`：

```ts
interface ManualAlexaVocRepository {
  put(input: PutManualAlexaVocInput): Promise<ManualAlexaVocWriteResult>;
  getCurrent(input: ManualAlexaVocScope): Promise<ManualAlexaVocRevision | null>;
  listCurrent(input: {
    organizationId: string;
    marketplace: string;
    asins: readonly string[];
  }): Promise<readonly ManualAlexaVocRevision[]>;
  listAtCutoff(input: {
    organizationId: string;
    marketplace: string;
    asins: readonly string[];
    dataCutoffAt: string;
  }): Promise<readonly ManualAlexaVocRevision[]>;
}
```

`listAtCutoff` 对每个 ASIN 选择 `captured_at <= dataCutoffAt` 的最高 `(captured_at, revision)`。查询必须同时包含 organization 和 marketplace；没有任何方法允许只按 ASIN 全局查询。

### 7.4 API 合同

#### 写入

保留浏览器兼容入口：

```http
POST /api/alexa-voc/import
Content-Type: application/json

{
  "asin": "B0XXXXXXXX",
  "marketplace": "US",
  "rawText": "..."
}
```

Web 路由继续执行同源 guard，并把 Cookie 和有界正文转发到 31901：

```http
POST /v1/manual-alexa-voc
```

31901 从认证 principal 取得 `organizationId` 和 `actorId`，不得接受客户端传入组织。它执行大小、ASIN、marketplace、报告 ASIN 一致性、至少 3 维和严格七维规范化校验，然后在 PostgreSQL 提交 revision。

成功响应：

```json
{
  "record": {
    "asin": "B0XXXXXXXX",
    "marketplace": "US",
    "revision": 4,
    "contentHash": "sha256-hex",
    "capturedAt": "2026-08-31T10:12:43.517Z",
    "normalizedRecord": {}
  },
  "filled": 7,
  "missing": [],
  "idempotent": false,
  "publication": {
    "status": "queued",
    "generation": 18
  }
}
```

`publication.status` 为 `queued | deduplicated | disabled | failed-to-queue`，只描述 legacy 投影发布；只要数据库提交成功，HTTP 仍为 200/201。首次 revision 返回 201，新增 revision 返回 200，同内容重试返回 200。

#### 当前读取

```http
GET /api/alexa-voc?marketplace=US&asins=B0AAA...,B0BBB...
```

Web 代理到：

```http
GET /v1/manual-alexa-voc?marketplace=US&asins=...
```

响应只返回已授权组织内的 current revisions、缺失 ASIN 和 `serverObservedAt`；不返回 `raw_report`、内部路径、publication lock 或数据库字段。

一次最多 10 个唯一 ASIN。无效输入 400；未登录 401；角色不足 403；数据库不可用 503。查询成功但某些 ASIN 没有动态记录仍返回 200，并在 `missingAsins` 列出，供页面继续使用 static fallback。

### 7.5 页面即时 overlay

页面建立唯一的 `manualVocOverlay`，key 为 `${marketplace}:${asin}`，value 包含 normalized record、revision、hash 和 capturedAt。

合并顺序固定：

1. 当前组织、当前 marketplace 下的 PostgreSQL overlay；
2. 同 marketplace 的 `rufusVocData` legacy static record；
3. 明确的“尚未录入”空状态。

导入 POST 成功后，前端直接用响应 `record` 原子更新 overlay，不等待 background rebuild；同时重新请求该 ASIN 的 GET 做服务端确认。页面 mount、登录恢复、marketplace 变化、草稿提交成 committed scope 和浏览器重新获得焦点时，按当前最多 10 个 ASIN批量 GET。

客户端只接受同 key 下 revision 更大的记录，或同 revision 且 hash 相同的确认；低 revision 响应不得覆盖新 POST 结果。同 revision 不同 hash 视为协议冲突，保留新值、显示可重试提示并记录诊断事件。

VOC 核心矩阵和 Alexa 导入面板必须读取同一个 `effectiveVocByAsin` selector。每列显示来源 badge：`Manual Alexa · PostgreSQL r4` 或 `Legacy static fallback`，避免把旧投影误认成新提交。

### 7.6 31901 动态读取与 run cutoff

`RepositoryVocSourceReader` 改为依赖注入异步 `ManualAlexaVocRepository` 和 legacy static source。对每个目标 ASIN：

1. 查询同组织、同站点且 `captured_at <= dataCutoffAt` 的最新 PostgreSQL revision；
2. 有动态 revision 就生成 `manual-voc` source record，并使用该 revision 的精确 `capturedAt`；
3. 动态记录缺失时，才读取静态 `rufusVocData`；
4. 静态记录仍使用 legacy date normalization，并在 snapshot provenance 标记 `legacy-static`；
5. 动态记录存在但 schema 损坏时 fail closed，返回 `source-error`，不得悄悄降级到可能不同内容的静态记录。

VOC 独立分析按钮每次创建**新 run**，服务端先取得 `dataCutoffAt`，再用同一值查询数据并创建 snapshot。事务顺序保证新 run 的 cutoff 不早于按钮动作前已提交的 Manual Alexa revision。

如果导入发生在旧 run 创建之后，旧 run 和 snapshot 保持不变；导入成功后 UI 将当前“尚未执行的 VOC 草稿运行指针”标记 stale，下一次点击自动创建新 run。系统不重启服务，也不把新数据注入已开始或已完成运行。

### 7.7 静态 publication 降级为 best-effort

PostgreSQL 提交成功后，异步兼容任务仍可更新：

- `data/alexa-voc-cache/<ASIN>.txt`；
- `app/rufus-voc-data.ts`；
- Alexa publication snapshot/state；
- immutable Web Artifact 和 reload request。

这些步骤全部在权威事务之外。失败只更新 publication health，不回滚数据库 revision、不让导入接口伪装失败、不阻塞页面 overlay 或 31901 动态读取。

publication worker 使用 `(organizationId, marketplace, asin, revision, contentHash)` 去重；generation 必须单调。由于静态文件目前不具备组织隔离能力，**只有显式配置的 legacy default organization + US** 可以生成全局静态投影；其他组织只使用 PostgreSQL，防止跨租户泄漏。

### 7.8 错误语义

| 条件 | HTTP / code | 数据副作用 | UI |
| --- | --- | --- | --- |
| Origin、会话或角色无效 | 401/403 | 无写入 | 固定鉴权提示 |
| ASIN、marketplace、正文或报告 ASIN 无效 | 400/422 | 无写入 | 显示检测到/缺失维度，不回显全文 |
| PostgreSQL 写入失败 | 503 `VOC_PERSISTENCE_UNAVAILABLE` | revision 不提交 | 保留现有 overlay，可重试 |
| 相同内容重复提交 | 200 | 无新 revision | 显示“内容未变化” |
| revision 并发冲突 | 服务端重试一次；仍冲突 409 | 不产生半写入 | 提示刷新后重试 |
| 数据库成功、publication 排队失败 | 200 + `failed-to-queue` | revision 已提交 | 数据立即显示，附“静态发布待恢复” |
| GET 部分缺失 | 200 | 无 | 每个缺失 ASIN 使用 legacy fallback |
| dynamic record schema 损坏 | 500/内部 `source-error` | 不修改历史 | 不降级冒充，运维告警 |

## 8. 切片二：`comparisonDraft` 单一编辑状态

### 8.1 状态模型

删除页面对 `inputs`、`asinDraft` 和 `activeAsins` 的并行所有权，替换为两个语义不同的对象：

```ts
type ComparisonDraft = {
  slots: readonly string[];       // 0–10 个原始编辑值
  normalizedAsins: readonly string[];
  issues: readonly DraftIssue[];  // invalid / duplicate；不足 3 不属于编辑错误
  source: "empty" | "url" | "project" | "run" | "user";
  basedOnProjectId: string | null;
  dirty: boolean;
  revision: number;               // 纯客户端单调序号，防止旧异步响应覆盖
};

type CommittedComparisonScope = {
  organizationId: string;
  marketplace: string;
  projectId: string;
  runId: string | null;
  asins: readonly string[];
  committedAt: string;
};
```

`comparisonDraft` 是唯一可编辑真相；输入框、批量 textarea、待保存提示和按钮校验都由它派生。`committedScope` 来自已加载项目或已创建运行，不可被输入事件修改。

矩阵预览可以显示草稿中的可识别 ASIN，但已保存报告、同步进度、运行状态和历史结果永远绑定 `committedScope`。页面必须在视觉上区分“正在编辑的新组合”和“当前打开的历史运行”。

### 8.2 编辑规则

- `add`：不足 10 个时增加空 slot。
- `remove`：删除任意 slot，包括最后一个。
- `replace`：输入框和批量粘贴都通过同一 reducer 替换 slot 集合。
- `clear`：变为 `slots: []`，不自动恢复历史 `activeAsins`。
- `normalize`：trim + uppercase；空 slot 不进入 `normalizedAsins`。
- 超过 10 个：编辑器保留前 10 个，并显示明确的 `too-many` 诊断；批量粘贴不得静默丢弃而不提示。
- 非 10 位 ASIN和重复项可留在草稿中供用户修正；不得触发同步或保存。
- 0–2 个合法 ASIN是合法编辑态，只在执行动作时提示“至少 3 个”。

### 8.3 保存与运行边界

统一函数 `snapshotValidComparisonDraft(draft, marketplace)`：

1. 读取一次 draft revision；
2. 规范化并拒绝 invalid、duplicate、少于 3、超过 10；
3. 返回冻结的 `{ marketplace, asins, draftRevision }`；
4. 后续项目创建、同步、VOC、SIF 和 UI 跳转全部使用该 snapshot，不再读取 React closure 中可能变化的 state。

默认行为：

- “保存组合”始终创建新的 project id，不查找或静默复用相同 ASIN 集合。
- “开始分析”在 dirty draft 或没有 committed project 时先创建新 project，再创建新 run。
- 已加载项目且 draft 完全未变时，“开始分析”可在该不可变 project 下创建新 run；仍不得修改旧 run。
- 如果发现已有相同组合，只能提示用户“已有相同组合，可打开”；除非用户明确点击打开，否则不复用。
- 项目创建成功后才更新 `committedScope`；运行创建成功后再写入 `runId`。
- 任一步失败时保留 draft，不把它伪装成已保存，也不回退到旧 `activeAsins` 启动任务。

### 8.4 历史不可变

项目的 `marketplace + asins` 创建后不可修改；run 的 project、ASIN scope、`dataCutoffAt` 和 snapshots 创建后不可修改。现有 PATCH 只允许名称、别名、备注等展示元数据；请求包含 `asins` 或 `marketplace` 返回 409 `IMMUTABLE_SCOPE`。

历史项目加载只执行：

1. 设置 `committedScope` 为历史项目/运行；
2. 复制其 ASIN 到一个新的、`dirty: false` 的 `comparisonDraft`；
3. 用户首次编辑后 `dirty: true`，并显示“将另存为新组合”。

删除收藏只影响收藏入口；本方案不删除 Agent project、run、snapshot 或报告。历史删除语义保持现状，不在本切片扩大。

### 8.5 URL 与 hydrate

URL 分离两种概念：

- `project` / workspace slug / `run`：定位 committed scope；
- `draftAsins`：可选的 0–10 编辑草稿，仅用于无 committed scope 的临时分享。

旧 `asins` 参数继续兼容读取，但进入页面后规范化为 `comparisonDraft`，不再直接创建 active scope。旧 URL 中 3–10 个合法 ASIN 可被迁移式 replace 为 `draftAsins`；0–2 个也能保留。含无效或重复项时只显示草稿诊断，不自动运行。

hydrate 优先级固定为：显式 project/run > 显式 `draftAsins` > legacy `asins` > empty。异步 project 请求返回时只有当请求 token 与当前 navigation revision 一致才可应用，防止旧项目响应覆盖用户新输入。

### 8.6 UI 状态流

```text
empty/editing (0–10)
  ├─ edit/clear/replace → editing
  ├─ save, invalid → editing + diagnostics
  ├─ save, valid → creating-project → committed-project
  └─ run, valid → creating-project? → creating-run → committed-run

committed-project/run
  ├─ edit first field → dirty-draft（历史结果仍绑定 committed scope）
  ├─ save dirty → new committed-project
  ├─ run dirty → new project + new run
  └─ open history → replace committed scope + seed clean draft
```

按钮 busy 状态按 draft revision + request id 管理。用户在请求期间继续编辑时，旧请求可以成功创建它自己的 snapshot，但不得把新 draft 标记为 clean；UI 提示“已保存提交时的组合，当前输入还有未保存修改”。

### 8.7 API 与认证

执行边界继续使用认证后的 31901 project/run API。新 project 请求携带客户端生成的 project id 和 `Idempotency-Key`；服务端按 `(organizationId, idempotencyKey)` 幂等，响应必须回显 project id、organizationId、marketplace 和 ASIN 顺序。客户端逐项核对后才能提交 run。

项目列表、读取和创建全部从会话 principal 取得组织；不得接受查询参数选择其他组织。member 可以创建自己的分析组合；删除、跨用户管理或组织级维护继续遵循既有角色策略。

文件型收藏元数据可以在过渡期继续使用，但其创建必须以 Agent project 已成功为前提并引用相同 project id。收藏写入失败只影响收藏展示，不得回滚或改写已创建的 Agent project/run；页面提供可重试的“保存到收藏”。

### 8.8 迁移与兼容

本切片无需新增草稿数据库表；草稿是客户端短生命周期状态。需要收紧 project ASIN scope 的服务合同和测试，但不批量修改现有项目。

既有项目照原样读取并视为不可变；现有同 ASIN 多项目全部保留。旧页面 URL、slug 和 `asins` 继续可打开。新 reducer 上线前后的状态不做 localStorage 自动迁移，避免错误恢复旧 `activeAsins`。

## 9. 切片三：SIF 严格响应与有界关键词降级

### 9.1 规范输出

把现有只有 `asin` 的记录扩展为带证据层级的不可混淆结构：

```ts
type KeywordEvidenceMode =
  | "target-canonical"
  | "target-parameter-retry"
  | "parent-listing"
  | "category-proxy";

type SifKeywordEvidence = {
  targetAsin: string;
  marketplace: string;
  mode: KeywordEvidenceMode;
  queriedAsin: string | null;
  categoryId: string | null;
  relationshipEvidence: RelationshipEvidence | null;
  queryVariant: string;
  queryWindow: SifKeywordQueryWindow;
  fetchedAt: string;
  status: "ready" | "empty" | "unavailable" | "schema-error" | "quota-blocked";
  keywords: readonly SifKeywordRecord[];
  attempts: readonly KeywordAttemptSummary[];
  crossValidation: readonly CrossValidationFact[];
};
```

`targetAsin` 永远是用户 committed scope 中的 ASIN。`queriedAsin` 是 SIF 实际接收的 ASIN；类目代理时为 null。UI 和下游分析按 `mode` 决定可用语义，不允许通过 `record.asin = targetAsin` 丢失 provenance。

### 9.2 严格 schema

每个 allowlist SIF operation/version 都有独立的严格输入和响应 adapter：

- 顶层对象、分页、keyword 行和数值范围使用 strict schema；
- keyword 必须为非空字符串；比例、搜索量、排名和竞价只接受合同允许的 number/null，不把任意字符串强转成 0；
- `target-canonical`、`target-parameter-retry` 和 `parent-listing` 才允许 listing traffic share / organic rank；
- `category-proxy` schema 不包含目标 listing traffic share 或目标 organic rank 字段；
- 未知版本、结构漂移、关键字段错型或 ASIN 回显不匹配返回 `schema-error` 并 fail closed；不得把畸形响应继续送入下一降级级别。

替代参数不是运行时猜字段。实现维护一个版本化 allowlist registry，每个 entry 固定 tool name、语义字段到 provider 参数的映射、适用 connector capability version 和响应 schema。启动时从 connector capabilities 选择一个已测试 entry；没有匹配 entry 就返回 `unavailable`。

### 9.3 降级顺序

对每个 target ASIN 固定执行：

#### Level 1：目标 ASIN，canonical 参数

调用当前 `market_get_asin_keyword_signals` 近 30 天 listing scope。严格有效且非空即结束，mode 为 `target-canonical`。

#### Level 2：目标 ASIN，替代参数重试

只有 Level 1 返回明确的 `INVALID_ARGUMENT` 或 `UNSUPPORTED_PARAMETER`，且 capability registry 为当前 provider version 提供了另一条**已测试、语义等价**参数映射时才执行一次。超时、鉴权失败、配额不足、5xx、schema-error 和有效空结果都不触发参数重试。

成功 mode 为 `target-parameter-retry`，`queriedAsin === targetAsin`。有效空结果进入 Level 3。

#### Level 3：已验证父体/主 Listing ASIN

仅当目标查询得到严格有效空结果，或 provider 明确表示该子体不可按 listing 查询时使用。父体/主 Listing 必须来自目标商品自身的可信关系字段：

1. 已持久化 catalog/variant 数据中明确的 `parentAsin` / `mainListingAsin`；或
2. Sorftime `product_detail` 对**同一 target ASIN**返回的明确父子/主 Listing 字段，并通过专用 strict schema。

只凭标题、品牌、类目、图片或相似度推断的 ASIN不合格。候选必须是不同于 target 的合法十位 ASIN，并保存 relationship evidence 的 provider、fetchedAt、target、parent/main 字段。

随后以已验证 ASIN执行一次 SIF canonical 查询。成功 mode 为 `parent-listing`；UI 固定显示“父体/主 Listing 关键词，非目标子 ASIN 独立流量”，所有流量占比和排名归属于 `queriedAsin`。

#### Level 4：类目代理关键词

仅当前三级都没有可用严格结果，并且目标 ASIN具有可信 browse node/category id 时执行。调用 capability registry 中 allowlist 的 SIF 类目关键词 operation；同一 job 内相同 `(marketplace, categoryId, queryWindow)` 只调用一次并共享结果。

mode 为 `category-proxy`，UI 固定显示“类目需求代理，不代表该 ASIN 流量”。只允许输出类目搜索需求、搜索量、趋势、竞价等类目/关键词级字段；目标 traffic share、目标自然排名、目标广告排名必须为 null 或不存在。

若类目身份也不可验证，则结束为 `unavailable`，明确显示数据缺口，不再猜测。

### 9.4 Sorftime 的边界

Sorftime 只允许产生：

- `parent/main listing relationship verified`；
- `category/browse node verified`；
- 销售、评论、价格或趋势与 SIF 方向是否一致的 cross-validation fact。

Sorftime 不允许产生或填充：

- 目标 ASIN 的 SIF `trafficShare`；
- 目标 ASIN 的 `organicRank`、广告排名或 SIF keyword count；
- 伪装成 `target-canonical` 的关键词列表。

交叉验证事实单独显示来源、指标、时间窗和一致/不一致/不可比较结论。即使 Sorftime 有类似关键词字段，也只能作为 `Sorftime cross-validation` 展示，不能进入 SIF target traffic 聚合。

### 9.5 缓存、额度与成本保护

缓存 key 至少包含：

```text
organizationId / marketplace / targetAsin / mode / queriedAsin-or-categoryId /
adapterVersion / queryWindow / topN
```

默认每个 target ASIN 的 SIF ASIN 查询上限为 3 次：canonical 1 次、替代参数最多 1 次、父体/主 Listing 最多 1 次。类目代理每个唯一类目每 job 最多 1 次并在 ASIN间复用。Sorftime 关系验证每 target 最多 1 次，已有新鲜 catalog relationship 时为 0 次。

关键词 enrichment 只对最终展示的去重 top N 关键词执行，默认 N=50；同 marketplace + keyword + 时间窗复用新鲜缓存。调用前通过现有 resource governor / quota ledger 预约额度，低于组织保留阈值时停止后续 fallback，返回 `quota-blocked`，不得透支后再报错。

重试规则：

- 参数替代属于一次有意的兼容尝试，不属于网络重试。
- 网络瞬时重试沿用 connector 的统一策略和 governor 计数，不在业务 fallback 中再次循环。
- 401/403、schema-error、明确 quota error 不重试。
- 每次 attempt 记录 provider、operation、adapterVersion、reason、mode、耗时、quota receipt 和脱敏 error code；不得记录密钥或完整原始响应。

### 9.6 UI 与下游分析

关键词卡片必须按 mode 显示四种不同 badge 和说明。排序/对比规则：

1. target 两种 mode 可以在目标 ASIN间做同口径流量对比；
2. parent-listing 只在相同 queried listing 语义下单列，不与子体 target 流量直接排名；
3. category-proxy 只进入需求发现，不进入竞品 ASIN 流量份额图；
4. cross-validation 只作为旁证，不改变 SIF 数值。

下游 VOC 定位或产品定义若消费关键词，必须收到 mode 和 provenance。没有 target 数据时可以引用“父体关键词”或“类目代理需求”，但结论文字必须保留限定词，不能写成“该 ASIN 的核心流量词”。

## 10. 跨切片一致性、并发与安全

### 10.1 组织与站点

- Manual VOC、project、run、keyword evidence 和缓存都以认证 principal 的 organizationId 为首要隔离维度。
- marketplace 由 allowlist schema 规范化，当前 UI 只提交支持站点。
- Web 不从请求 body 信任 organizationId；内部服务也必须复核 project.organizationId。
- 静态全局 fallback 只能服务显式 legacy default organization，不能泄露到其他组织。

### 10.2 不可变运行

运行创建时冻结：organization、marketplace、ASIN 顺序、project id、dataCutoffAt 和各数据 snapshot。之后的 Alexa revision、草稿编辑、SIF cache refresh 或 Sorftime验证只影响新运行。

### 10.3 请求幂等

- Alexa：以当前 head content hash 实现内容幂等。
- 新组合：以组织 + Idempotency-Key 幂等创建；相同 key 不得创建两个项目。
- run：沿用组织、project、idempotency scope/key；双击只创建一个 run。
- SIF：以 immutable query/cache key 和 governor receipt 去重；同 job 不重复消费类目代理额度。

### 10.4 敏感信息

原始 Alexa 报告仅存数据库受控字段和现有 legacy cache；不进入 GET 响应、日志、错误、Artifact manifest 或 telemetry。SIF/Sorftime密钥、headers、原始响应和数据库 URL 同样不得记录。日志只包含组织哈希/内部 id、ASIN、revision、mode、状态码和耗时。

## 11. 可观测性

### 11.1 Manual Alexa VOC 指标

- `manual_alexa_voc_write_total{result=new|updated|idempotent|rejected|failed}`
- `manual_alexa_voc_read_total{source=postgres|legacy_static|missing|schema_error}`
- `manual_alexa_voc_overlay_lag_ms`：POST capturedAt 到页面确认时间
- `manual_alexa_voc_cutoff_excluded_total`
- `manual_alexa_voc_publication_total{status=queued|applied|failed|disabled}`
- `manual_alexa_voc_publication_lag_seconds`

publication dashboard 必须同时显示 PostgreSQL latest revision/hash、静态 generation/hash、current Artifact id/health 和 reload request 状态。三者不一致时标记“运行时已可用，静态投影滞后”，不能误报数据丢失。

### 11.2 Draft 指标

- `comparison_draft_action_total{action=save|run,result=valid|invalid|failed}`
- `comparison_project_create_total{result=created|idempotent|conflict}`
- `comparison_stale_response_ignored_total`
- 客户端诊断事件：提交 snapshot revision、当前 draft revision、project/run id；不记录用户备注。

### 11.3 Keyword fallback 指标

- `sif_keyword_attempt_total{mode,result,error_code,adapter_version}`
- `sif_keyword_fallback_depth{mode}`
- `sif_keyword_schema_error_total`
- `sif_keyword_quota_blocked_total`
- `sif_keyword_cache_hit_total{mode}`
- `sorftime_keyword_verification_total{purpose=relationship|category|trend,result}`

告警优先级：跨组织读取或同 revision 不同 hash 为最高；持续 schema-error、动态读取回退率升高、publication 长期滞后和 quota-blocked 突增为运维告警。

## 12. 分阶段发布顺序

### Phase 0：合同与迁移预备

- 新增 repository interface、严格 schemas、向前 migrations 和 feature flags。
- 在 CI 的 SQLite/PostgreSQL migration 测试验证全新安装与已有数据库升级。
- 默认所有新读写开关关闭；不触碰现有运行服务和静态数据。

### Phase 1A：Manual VOC 双投影写入

- 打开 PostgreSQL 权威写开关；导入必须先成功提交 DB。
- legacy cache/TS/publication 在事务后 best-effort 执行。
- 页面仍可暂用 static，但 shadow GET 比较 DB revision 与 static hash，观察无误后进入下一阶段。

### Phase 1B：页面 overlay 与 31901 动态读取

- 先给内部/管理员打开页面动态 GET/POST overlay，再逐步全组织开启。
- 随后开启 `RepositoryVocSourceReader` PostgreSQL-first；用 run cutoff 集成测试验证同日时间语义。
- 保留 static fallback 开关至少一个发布周期。

### Phase 2：`comparisonDraft` reducer

- 上线单一草稿状态、动作快照和新组合默认创建。
- 首先只替换输入/按钮状态，再切换 URL hydrate 和各保存入口。
- 确认所有 tab 都使用同一 snapshot 后删除旧状态接线；不删除历史项目。

### Phase 3：SIF 严格 adapter 与 fallback

- 先 shadow 解析当前响应，不改变 UI；确认 strict schema 覆盖率。
- 开启 canonical + 参数替代，再开启 verified parent/main listing。
- 最后开启 category proxy 和 Sorftime cross-validation badge。
- 每级都有独立开关和额度上限，可单独关闭，不影响前两切片。

## 13. 回滚

### 13.1 Manual VOC

- 页面 overlay异常：关闭 UI dynamic read，恢复 static fallback；PostgreSQL revision 保留。
- 31901 动态 source 异常：关闭 PostgreSQL-first reader，恢复 legacy static source；不删除新表或 revision。
- publication 异常：关闭 best-effort publisher，不回退权威 DB 写入。
- 只有数据库本身不可用时，导入明确返回 503；不得静默回到仅写静态文件并返回成功。

### 13.2 Draft

关闭 `comparisonDraft` UI 开关可恢复旧编辑组件，但新建项目仍保持不可变规则。已创建的新组合和运行不删除、不合并。

### 13.3 Keyword fallback

按深度逆序关闭：category proxy → parent/main listing → parameter retry → strict canonical。关闭 fallback 后保留已写证据记录及 provenance，但新运行不再消费它们。不得把 fallback 记录重标为 target canonical。

数据库 migration 只向前，不 drop 表、不删列；回滚代码可以忽略新表。

## 14. 测试策略

实现遵循 RED-GREEN-REFACTOR。每个切片独立测试、独立提交、独立 feature flag，之后再做跨切片验收。

### 14.1 Manual VOC 单元与 repository 测试

1. 同 organization/marketplace/ASIN 首次写入 revision 1，capturedAt 是完整 UTC datetime。
2. 相同 hash 重试不增加 revision、不改变 capturedAt。
3. 不同内容递增 revision；回退到更早内容仍创建新 revision。
4. 两个并发不同写入串行化，最终 head 指向最高 revision，历史无缺号或半写入。
5. 两个 organization 或 marketplace 的相同 ASIN互不可见。
6. `listAtCutoff` 选择 cutoff 前最后 revision；cutoff 后记录得到 `after-cutoff`，不使用日期末尾伪时间。
7. dynamic schema 损坏 fail closed；真正缺失才使用 legacy static。
8. SQLite 和 PostgreSQL migration 从空库、旧最新版本升级均通过。

### 14.2 Manual VOC API/UI 测试

1. 未登录、跨源、角色不足请求在解析/写库前拒绝。
2. 真实七问格式 7/7 导入后响应含 revision/hash/capturedAt/normalizedRecord。
3. 前端收到 POST 后无需 Artifact rebuild 即更新对应矩阵列。
4. 页面刷新后 GET 恢复相同 revision；过时 GET 不覆盖新 POST。
5. publication 排队失败仍显示 DB 数据和“静态发布待恢复”。
6. 31901 不重启，新建 VOC 独立分析 run 能读到导入 revision。
7. 导入晚于旧 run cutoff 时旧 snapshot 不变；新 run 读取新 revision。
8. 非 legacy default organization 不生成全局静态 TS 数据。

### 14.3 Draft reducer 与集成测试

1. 0、1、2、3、10 个 ASIN都可编辑；11 个显示 too-many；clear 得到真正空草稿。
2. invalid/duplicate 保留在 UI，保存/运行拒绝且没有 API side effect。
3. 每个 tab 的保存和运行使用同一个 frozen snapshot。
4. dirty draft 默认创建新 project；相同 ASIN 的旧 project 不被静默复用。
5. clean project 可创建新 run，旧 run/snapshot/report 不变。
6. 请求期间继续编辑时，旧响应不把新 draft 标记 clean。
7. project/run hydrate 的旧异步响应不覆盖新 navigation 或用户输入。
8. legacy `asins` URL、slug、project/run 和 0–2 个 `draftAsins` 均按规定恢复。
9. PATCH ASIN scope 返回 409；元数据 PATCH 仍兼容。

### 14.4 SIF adapter 与 fallback 测试

1. canonical 严格有效响应输出 `target-canonical`，不执行后续调用。
2. 明确参数不兼容且 registry 有匹配时只重试一次；其它错误不触发替代参数。
3. unknown fields/错型/ASIN 回显不匹配触发 schema-error 且停止，不使用畸形数据降级。
4. 有效空响应 + 已验证 parent/main 才查询父/主 Listing，并保留 target/queried 两个 ASIN。
5. 推断关系或不匹配 Sorftime响应被拒绝。
6. category proxy 只输出类目字段，目标流量/排名为空，UI 有明确 badge。
7. Sorftime cross-validation 不改变任何 SIF 数值。
8. 每 target SIF ASIN 调用不超过 3 次；相同类目代理每 job 只调用一次。
9. quota floor 触发 `quota-blocked`，不再发起 provider 调用。
10. cache key 包含组织、站点、mode、实际查询对象、adapter version 和窗口，不能跨组织复用。

### 14.5 端到端验收场景

1. 用户打开含 3 个子 ASIN 的组合，给其中一个粘贴 7/7 Alexa 报告。
2. 导入响应成功后 2 秒内该列显示 PostgreSQL revision badge；不等待 build。
3. 不重启任何服务，点击 VOC 独立分析；新 run snapshot 包含该 revision，cutoff 不早于 capturedAt。
4. 把草稿删到 2 个，页面允许继续编辑但运行按钮给出边界错误；重新加到 3 个后运行。
5. 新运行创建新组合，不修改步骤 1 的项目或任何旧报告。
6. 某目标 SIF canonical 返回有效空结果：若有验证父体则显示父体 badge；无父体但有类目则显示类目代理；两者都没有则显示明确缺口。
7. 页面和导出的报告均不会把父体、类目或 Sorftime旁证描述成目标 ASIN 流量。

## 15. 验收标准

只有同时满足以下条件才算完成：

- Manual Alexa VOC 的成功语义由 PostgreSQL commit 决定，页面和 31901 均动态读取同一 revision。
- 每条动态记录具有精确 UTC capturedAt、单调 revision、SHA-256 hash 和组织/站点隔离。
- static TS/publication 失败不阻止即时矩阵或新 VOC 独立分析，且 legacy fallback 仍可受控回滚。
- 用户可编辑 0–10 个 ASIN；保存/运行只接受 3–10 个合法唯一 ASIN。
- `inputs`、`asinDraft`、`activeAsins` 不再作为三个可变业务真相；所有动作消费同一冻结 snapshot。
- 默认另存新组合；历史 project/run/snapshot/report 未被更新或删除。
- SIF 每级响应严格校验，fallback 有界、有额度记账、有 provenance。
- parent/main listing 和 category proxy 在 UI、API、缓存和下游分析中均不能冒充 target ASIN。
- Sorftime 只作交叉验证，不能写入 target SIF traffic 字段。
- 定向测试、全量测试、lint、typecheck、fresh build、SQLite/PostgreSQL migration test 和隔离端口 E2E 全部通过。
- 部署和人工验证不得启动第二套 Web、不得监听 3000、不得替换 31901/58258，也不得包含用户现有生成数据 WIP。

## 16. 实施文件责任边界

以下是责任范围，不是要求一次提交全部修改：

| 范围 | 主要责任 |
| --- | --- |
| `server/db/migrations/*`、`server/db/migrations/postgres/*` | Manual VOC heads/revisions 向前迁移 |
| `server/db/*repository*` | 租户隔离、revision 事务、cutoff 查询 |
| `server/routes/*`、`shared/agent-contracts.ts` | Manual VOC、project/run 与严格错误合同 |
| `server/data/repository-voc-source.ts` | PostgreSQL-first 动态 VOC + legacy fallback |
| `app/api/alexa-voc/*`、`app/alexa-voc-import-panel.tsx` | 同源代理、POST overlay、publication 非阻塞提示 |
| `app/page.tsx` 及拆出的 reducer/selectors | `comparisonDraft`、`committedScope`、统一动作 snapshot、矩阵 overlay |
| `scripts/build-sif-keyword-analysis.mjs`、`scripts/lib/sif-*` | strict adapter registry、有界 fallback、provenance、quota/cache |
| `app/sif-keyword-analysis-data.ts` 的生成合同及消费者 | mode/target/queried/category badge 与下游限制 |
| tests | repository、API、UI reducer、provider fixtures、迁移、E2E 与回归 |

## 17. 自检结论

- **未决项：** 无。参数替代通过版本化 allowlist registry 绑定已测试 connector contract，不留运行时猜参事项。
- **顺序：** 明确为 PostgreSQL Manual VOC → `comparisonDraft` → SIF fallback；三个切片可独立开关和回滚。
- **权威源：** Manual Alexa VOC 只有 PostgreSQL 一个运行时权威源；静态 TS 是 legacy fallback，不存在双主冲突。
- **时间语义：** capturedAt 为事务内精确 UTC；旧 run 不变，新 run 读取 cutoff 前最新 revision，消除日期末尾折算歧义。
- **历史语义：** Manual VOC revision、project、run、snapshot 和报告均不删除、不覆盖；草稿变化默认创建新组合。
- **来源语义：** target、parent/main、category proxy、Sorftime cross-validation 四类不能互相冒充。
- **范围：** 不包含 provider 迁移、自动 Alexa 抓取、历史删除、全量收藏存储迁移或多站点扩展。
- **成本：** SIF/Sorftime 调用有硬上限、共享缓存、quota floor 和 receipt；publication 不影响业务成功。
- **回滚：** 每个切片均可通过独立开关退回上一读路径，数据库迁移只向前且保留所有新增历史数据。
