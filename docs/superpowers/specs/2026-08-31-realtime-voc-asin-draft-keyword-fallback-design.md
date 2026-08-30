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

交付时必须拆成三个独立 subproject 和三个独立 implementation plan：`01-realtime-manual-voc`、`02-comparison-draft`、`03-keyword-evidence-fallback`。每个 subproject 有自己的迁移、feature flag、测试矩阵、上线判定与回滚点；统一规格只定义共享合同，绝不生成一个跨三个领域的巨型实施任务或一次性发布。

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
- 无论哪一级成功，都保留 `targetAsin` 与实际 `lookupAsin` / `categoryId`，不得把父体或类目指标显示成子体自身流量。
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

导入首先提交 PostgreSQL，页面和 31901 动态读取；现有静态 TS/Artifact 异步跟随。它同时解决即时矩阵、精确 capturedAt、组织隔离和无需服务重启，并保留 legacy fallback 和低风险回滚。代价是增加运行时持久化表、repository/API 合同和 UI overlay，但这些都是运行时数据应有的边界。

### 5.3 完全删除静态 VOC 与生成文件

页面和 31901 只读 PostgreSQL，立刻移除 `rufus-voc-data.ts`、cache 和 publication。长期最简单，但会一次性切断现有回滚路径，并涉及历史静态数据迁移/删除，超出本方案明确范围。该方案不采用；静态路径只降级为 legacy fallback。

ASIN 草稿方面，继续给三份 state 补同步 effect 只能增加竞态，选择 reducer 单一编辑真相；关键词方面，直接使用 Sorftime 或无标签父体数据会污染口径，选择严格 schema + 有界、带 provenance 的降级链。

## 6. 总体架构边界

```text
Browser / 31900
  ├─ comparisonDraft（纯编辑态，0–10）
  ├─ committedScope（项目/运行不可变快照）
  ├─ GET/POST /api/alexa-voc/*（trusted-origin internal Web proxy）
  └─ static TS only as legacy fallback
              │ createAgentServiceClient（proxy token + trusted Origin + session Cookie）
              ▼
Agent / 31901
  ├─ ManualAlexaVocService
  │    ├─ parser + strict normalized record schema
  │    └─ ManualAlexaVocRepository → PostgreSQL
  ├─ RepositoryVocSourceReader（按 org/marketplace/cutoff 动态读取）
  ├─ project/run lifecycle（不可变 ASIN scope + dataCutoffAt）
  ├─ KeywordEvidenceRepository（运行时权威 evidence / receipt）
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
2. 31900 负责用户交互、同源代理和即时 overlay，不自行认定组织身份，不自行生成权威时间。所有到 31901 的请求复用现有 `createAgentServiceClient`，同时携带内部 proxy token、受信 Origin 与用户 session Cookie；仅转发 Cookie 不构成合法 Agent 请求。
3. 静态 TS 和 Artifact 是 legacy 兼容读模型，不是数据库的写前日志，也不是提交事务的一部分。
4. 草稿仅存在于当前浏览器编辑会话；一旦保存或运行，服务端以动作请求中的不可变 snapshot 为准。
5. `KeywordEvidenceRepository` 是 SIF 关键词运行时权威源；SIF adapter 负责 provider 参数与严格响应映射，业务层只接收并持久化已经标注来源模式的规范记录。全局生成 TS 只作兼容投影。
6. Sorftime adapter 不得实现或返回 `target-asin-traffic` 类型。

## 7. 切片一：PostgreSQL Manual Alexa VOC 权威源

### 7.1 数据模型

新增 revisions、heads、publication outbox 与 access audit 表，并为 SQLite 测试后端和 PostgreSQL 正式后端分别增加**仅向前**的新迁移；不得改写已有 migration。

#### `manual_alexa_voc_heads`

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `organization_id` | text / FK 语义，非空 | 租户边界 |
| `marketplace` | text，非空，首发 CHECK `IN ('US')` | 真实 allowlist 站点；扩站点走新迁移 |
| `asin` | text，非空 | 规范化 10 位 ASIN |
| `latest_revision` | bigint，`>= 1` | 当前 revision；HTTP/JSON 中必须序列化为十进制字符串 |
| `latest_content_hash` | char(64)，非空 | 规范化七维 + 原文的 SHA-256 |
| `latest_captured_at` | timestamptz，非空 | 数据库事务内生成的精确 UTC 时间 |
| `updated_at` | timestamptz，非空 | head 最后变化时间 |

主键为 `(organization_id, marketplace, asin)`。revisions 建立唯一键 `(organization_id, marketplace, asin, revision, content_hash, captured_at)`；heads 的六列 `(organization_id, marketplace, asin, latest_revision, latest_content_hash, latest_captured_at)` 建立复合外键指向它，保证 head 指向的 revision、hash、capturedAt 完全一致，而不只是 revision 数字一致。

#### `manual_alexa_voc_revisions`

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `organization_id` | text，非空 | 租户边界 |
| `marketplace` | text，非空，首发 CHECK `IN ('US')` | 站点边界 |
| `asin` | text，非空 | 目标子 ASIN |
| `revision` | bigint，`>= 1` | 每个 scope 单调递增；HTTP/JSON 中为十进制字符串 |
| `content_hash` | char(64)，非空 | 幂等与审计哈希 |
| `captured_at` | timestamptz，非空 | 本 revision 正式提交时间 |
| `normalized_record` | jsonb / SQLite text JSON，非空 | 经指定 schema/parser version 校验的七维记录 |
| `normalized_schema_version` | text，非空 | 规范记录 schema 版本 |
| `parser_version` | text，非空 | 产生该记录的确定性解析器版本 |
| `raw_report_sha256` | char(64)，非空 | 原文明文 hash，密文到期清除后仍保留 |
| `raw_report_ciphertext` | bytea / SQLite blob，可空 | 应用层 envelope encryption 后的原始报告；DB 约束密文最大 135168 bytes；仅保留策略清理后可空 |
| `raw_report_plaintext_bytes` | integer，`0 < n <= 131072` | 数据库 CHECK 的 UTF-8 明文字节数；不是字符数 |
| `raw_report_key_version` | text，可空 | 加密 key 版本，不保存 key 本身；与 ciphertext 同空/同非空 |
| `created_by` | text，非空 | 当前登录 user id |
| `created_at` | timestamptz，非空 | 与 `captured_at` 相同事务时钟 |

主键为 `(organization_id, marketplace, asin, revision)`；增加 `(organization_id, marketplace, asin, captured_at DESC, revision DESC)` 索引。禁止覆盖或删除 revision。

当前 schema 没有 `organizations` 表可供 FK。现实约束是：`created_by` 外键指向 `users(id)`；服务事务在写入前锁定/读取该 user，并校验 `users.organization_id === principal.organizationId`、状态 active、角色允许，同时所有 repository SQL 强制带 organization predicate。迁移为 `users(id, organization_id)` 增加 unique constraint，并让 revisions 的 `(created_by, organization_id)` 使用复合外键，补上 actor 与租户的数据库级一致性；不虚构不存在的 organizations FK。

#### `manual_alexa_voc_publication_outbox`

每个已提交 revision 在**同一事务**插入唯一 outbox 行，唯一键为 `(organization_id, marketplace, asin, revision, content_hash)`。字段包括 `status(pending|leased|applied|failed)`、attempt count、next attempt、lease owner/expiry、last error code 和目标 generation；不保存 Cookie、密钥或原文。周期 dispatcher 从 outbox 构建 legacy 投影，reconciler 定期比较 heads、outbox、owner manifest 和 current Artifact，补建缺失/失败任务。同内容幂等导入即使不生成 revision，也必须检查 outbox/applied 状态并可安全补排。

#### `manual_alexa_voc_access_audit`

记录 raw report 的 create/decrypt/reparse/export/delete-policy 事件，只含 actor、organization、scope、revision、purpose、时间和结果。原文默认不提供 UI 下载；解密仅限服务内部重新解析和管理员审计能力。保留策略固定为：revision 与 normalized record 随历史运行长期保留；原文密文默认保留 365 天后由审计任务清除密文并保留 hash/normalized record/audit，组织若有更长合规策略则取更长值。任何清除都不删除 revision、snapshot、项目或报告。

原文使用独立的 versioned `MANUAL_VOC_RAW_REPORT_KEYRING` 做 AES-256-GCM envelope encryption，AAD 固定包含 organization、marketplace、ASIN、revision、schema/parser version；旧 key 只读、新 active key 写入。正式环境缺少有效 active key 时 import 在 DB 写入前返回 503，不允许明文降级。key rotation 通过审计化后台任务重加密，不改变 contentHash、revision 或 capturedAt。

`captured_at` 必须来自 31901 在事务内取得的数据库 `clock_timestamp()`，并序列化为带 `Z` 的完整 ISO-8601；不能使用 `YYYY-MM-DD`、浏览器时间或文件 mtime。取得 head row lock 后读取一次 `clock_timestamp()`，同一个值写入 revision、head、outbox createdAt。JavaScript 合同至少保留毫秒精度，数据库保留其原生更高精度。

### 7.2 哈希与幂等

内容哈希按以下 canonical payload 计算：

```json
{
  "marketplace": "US",
  "asin": "B0XXXXXXXX",
  "normalizedSchemaVersion": "alexa-voc-record/v2",
  "parserVersion": "deterministic-alexa-parser/v3",
  "normalizedRecord": {},
  "rawReportSha256": "..."
}
```

JSON key 按稳定顺序序列化，数组保持解析器输出顺序，字符串使用既有规范化结果。schema/parser version 必须参与 hash，确保解析规则变化不会被误判为同内容；hash 不包含组织、actor、时间或 revision。

写入事务对 head 行执行锁定：

import 与 run 共用由 `(organizationId, marketplace, asin)` 稳定派生的 transaction advisory lock；run 按规范化 ASIN 排序依次取得全部锁，import 取得单一锁，避免死锁并定义线性化顺序。

- 没有 head：在 scope advisory lock 下读取时间，插入 revision 1、head 和 outbox。
- 新 hash 等于 head hash：返回当前 revision、原 `capturedAt` 和 `idempotent: true`，不插入 revision、不更新时间。
- 新 hash 不同：取得 head row lock 后读取一次数据库时间，插入 `latest_revision + 1` 和 outbox，随后用同一 hash/时间更新 head，返回 `idempotent: false`。
- 并发首次写入通过主键冲突重读并重试一次事务；并发更新按 head 锁串行化。

相同内容重试虽然不插入 revision，但事务必须确认对应 outbox 已存在；缺失或 failed 时重新置为 pending。允许用户以后重新提交与更早 revision 相同的内容；只要它不同于**当前** head，就生成新 revision，表示一次明确回退。这样既保证网络重试幂等，也保留业务修订历史。

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

repository 的“0 rows”与“读取失败”必须是不同类型：只有租户限定 SQL **成功执行且返回 0 行**才是 `NotFoundInTenant` 并允许评估 legacy fallback；连接失败、timeout、permission、missing table/schema mismatch、JSON deserialize/schema validation 都分别映射 typed repository error，API 返回 503 或 snapshot source-error，绝不降级为 static。

新增服务端原子方法，取代“先在 route 取 now，再读 source，再分别写 run/snapshot”的顺序：

```ts
createRunWithVocSnapshot(input: {
  principal: RequestPrincipal;
  projectId: string;
  mode: "existing-data" | "collect-missing";
  idempotencyKey: string;
}): Promise<{ run: AnalysisRun; snapshot: DataSnapshot }>;
```

该方法在同一个 PostgreSQL transaction 中：锁定并校验 actor/project/organization/immutable ASIN scope；按 ASIN 排序取得与 import 相同的 advisory locks；读取一次数据库 `clock_timestamp()` 作为 run `dataCutoffAt`；按该 cutoff 选择每个 ASIN revision；创建 run、stages、snapshot 和 job。外部 `CreateRunRequest` 删除 `dataCutoffAt` 字段并使用 strict schema，客户端若提交该字段直接 400，不允许浏览器控制 cutoff。共享锁协议保证 import/run 并发线性化：先取得 scope lock 并提交的 import 必须进入新 run，run 先取得锁并确定 cutoff 后才提交的 import 只能进入下一 run。

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

兼容期同时接受历史字段 `text` 和新字段 `rawText`，但二者必须恰有一个；同时出现或都缺失返回 400。规范化后内部只使用 `rawText`，最大值按 UTF-8 字节 131072 校验而非字符数。

Web 路由继续执行同源 guard，并通过现有 `createAgentServiceClient` 把有界正文转发到 31901：

```http
POST /v1/manual-alexa-voc
```

内部请求必须同时具备 `AGENT_SERVICE_PROXY_TOKEN`、精确匹配 `AGENT_SERVICE_TRUSTED_ORIGINS` 的 Origin 和有效 session Cookie；缺少任一项均在读取正文/写库前拒绝。31901 从认证 principal 取得 `organizationId` 和 `actorId`，不得接受客户端传入组织。它执行大小、ASIN、marketplace、报告 ASIN 一致性、至少 3 维和严格七维规范化校验，然后在 PostgreSQL 提交 revision。

成功响应：

```json
{
  "scope": {
    "organizationId": "principal-org-id",
    "marketplace": "US"
  },
  "record": {
    "asin": "B0XXXXXXXX",
    "marketplace": "US",
    "revision": "4",
    "contentHash": "sha256-hex",
    "capturedAt": "2026-08-31T10:12:43.517Z",
    "normalizedRecord": {}
  },
  "filled": 7,
  "missing": [],
  "idempotent": false,
  "publication": {
    "status": "pending",
    "generation": "18"
  }
}
```

所有 bigint 字段（revision、generation、attempt/receipt sequence）在 JSON 中使用十进制字符串，禁止转换为 JavaScript number。`publication.status` 为 `pending | deduplicated | disabled`，直接来自同事务 outbox/配置；dispatcher 后续失败不会改变本次 HTTP 响应。首次 revision 返回 201，新增 revision 返回 200，同内容重试返回 200。

#### 当前读取

```http
GET /api/alexa-voc?marketplace=US&asins=B0AAA...,B0BBB...
```

Web 代理到：

```http
GET /v1/manual-alexa-voc?marketplace=US&asins=...
```

响应回显 principal 的 `scope.organizationId + marketplace`，并只返回该 scope 内的 current revisions、缺失 ASIN 和 `serverObservedAt`；不返回 raw report、内部路径、publication lock 或数据库字段。客户端必须把回显 scope 与请求捕获的 session/org epoch 一并核对。

一次最多 10 个唯一 ASIN。无效输入 400；未登录 401；角色不足 403；数据库不可用 503。查询成功但某些 ASIN 没有动态记录仍返回 200，并在 `missingAsins` 列出；页面仅在 eligibility token 与 owner manifest 都有效时使用 stale static fallback。

### 7.5 页面即时 overlay

页面建立唯一的 `manualVocOverlay`，key 为 `${organizationId}:${marketplace}:${asin}`，value 包含 normalized record、revision、hash、capturedAt 和 `sessionOrgEpoch`。任何 runtime VOC overlay、GET cache、query key、selector memo 和 background refresh key 都必须使用完整三元 scope，不得只用 marketplace + ASIN。

认证状态维护单调 `sessionOrgEpoch`，其 identity 为 session id/hash-derived opaque id + organizationId。登出、登录、用户切换、organization 变化或 session refresh 得到不同 identity 时，先递增 epoch 并同步清空 overlay/cache/in-flight controllers，再允许新请求。每个请求捕获发起时 epoch；响应落地前同时核对 epoch、organizationId、marketplace、request generation 和 revision。旧 epoch 请求即使稍后成功也只能丢弃，不能写入缓存、矩阵或 toast。

合并顺序固定：

1. 当前组织、当前 marketplace 下的 PostgreSQL overlay；
2. 通过共享 `LegacyVocReadEligibilityGate` 的同 owner、同 marketplace `rufusVocData` legacy static record；
3. 明确的“尚未录入”空状态。

第 2 级必须持有本次 31901 GET 返回的 `tenantQuerySucceeded=true + missingAsin + legacyEligibilityToken`；网络错误或 typed DB error 没有 token，selector 直接进入 source-error，不能因浏览器恰好打包了 static 就显示 fallback。

导入 POST 成功后，前端直接用响应 `record` 原子更新 overlay，不等待 background rebuild；同时重新请求该 ASIN 的 GET 做服务端确认。页面 mount、登录恢复、marketplace 变化、草稿提交成 committed scope 和浏览器重新获得焦点时，按当前最多 10 个 ASIN批量 GET。

客户端只接受同 scope、同 epoch 下 revision 更大的记录，或同 revision 且 hash 相同的确认；低 revision 响应不得覆盖新 POST 结果。同 revision 不同 hash 视为协议冲突，保留新值、显示可重试提示并记录诊断事件。

static Artifact 必须带不可变 owner manifest：`{ ownerOrganizationId, marketplace, artifactGeneration, sourceHeadsHash, generatedAt }`，每 ASIN 投影还带精确 `capturedAt`、revision 字符串和 contentHash。Web selector 与 31901 static reader 复用同一个 `LegacyVocReadEligibilityGate(principalOrg, marketplace, ownerManifest)`；只有 owner org、marketplace、schema 以及 manifest generation 与当前加载 Artifact identity 都匹配才可读。31901 GET 同时返回其 gate decision 和 manifest identity；Web 只有在本地 manifest identity 与该 decision **完全相同**时才能合并本地 static，否则显示 missing，从而保证 Web/31901 不会各自选中不同代静态数据。无 owner 的遗留 Artifact 不能被任意组织读取：部署时只允许通过一次性、审计化 migration 绑定到固定 `LEGACY_VOC_DEFAULT_ORGANIZATION_ID`，若该配置缺失/无效则隔离禁用 legacy static。该默认组织必须是已存在 active user 所属组织，不能用 `*`、空字符串或请求参数推导。

VOC 核心矩阵和 Alexa 导入面板必须读取同一个 `effectiveVocByAsin` selector。每列显示来源 badge：`Manual Alexa · PostgreSQL r4` 或 `Stale legacy static · generation N`，避免把旧投影误认成新提交或实时数据。

### 7.6 31901 动态读取与 run cutoff

`RepositoryVocSourceReader` 改为依赖注入异步 `ManualAlexaVocRepository` 和 legacy static source。对每个目标 ASIN：

1. 查询同组织、同站点且 `captured_at <= dataCutoffAt` 的最新 PostgreSQL revision；
2. 有动态 revision 就生成 `manual-voc` source record，并使用该 revision 的精确 `capturedAt`；
3. 租户限定查询成功且该 ASIN 返回 0 行时，才调用共享 eligibility gate 评估静态 `rufusVocData`；任何 typed DB/schema/deserialize error 都终止为 503/source-error；
4. 合格静态记录使用 owner manifest 内每 ASIN 的精确 capturedAt；只有一次性绑定前的历史数据才允许 date normalization，并标记 `legacy-static-date-only` 与 stale；
5. 动态记录存在但 schema 损坏时 fail closed，返回 `source-error`，不得悄悄降级到可能不同内容的静态记录。

VOC 独立分析按钮每次创建**新 run**，并调用 `createRunWithVocSnapshot`。cutoff、revision selection、run 和 snapshot 必须来自同一 DB transaction/同一 DB clock，禁止 route 先取应用服务器时间再调用 reader。事务顺序保证按钮动作前已提交的 Manual Alexa revision 进入新 run；并发边界由锁顺序和 integration test 证明。

如果导入发生在旧 run 创建之后，旧 run 和 snapshot 保持不变；导入成功后 UI 将当前“尚未执行的 VOC 草稿运行指针”标记 stale，下一次点击自动创建新 run。系统不重启服务，也不把新数据注入已开始或已完成运行。

### 7.7 静态 publication 降级为 best-effort

PostgreSQL 提交成功后，异步兼容任务仍可更新：

- owner-scoped、无原文的 Alexa normalized publication snapshot；
- `app/rufus-voc-data.ts`；
- Alexa publication snapshot/state；
- immutable Web Artifact 和 reload request。

实际文件构建在权威事务之外，但 publication intent 通过同事务 outbox 持久化。失败只更新 outbox/publication health，不回滚数据库 revision、不让导入接口伪装失败、不阻塞页面 overlay 或 31901 动态读取。dispatcher 使用 lease/attempt/backoff，reconciler 周期扫描 heads 与 applied owner manifest；进程在 DB commit 后、排队前崩溃也能自动补排。

publication worker 使用 `(organizationId, marketplace, asin, revision, contentHash)` 去重；generation 必须单调。每 ASIN 静态投影保留数据库精确 capturedAt，Artifact 写入不可变 owner manifest。由于静态文件目前不具备多组织并存能力，**只有显式、有效的 legacy default organization + 该 manifest marketplace** 可以生成全局静态投影；配置缺失时 publication status 为 disabled，所有组织只使用 PostgreSQL。

### 7.8 错误语义

| 条件 | HTTP / code | 数据副作用 | UI |
| --- | --- | --- | --- |
| Origin、会话或角色无效 | 401/403 | 无写入 | 固定鉴权提示 |
| ASIN、marketplace、正文或报告 ASIN 无效 | 400/422 | 无写入 | 显示检测到/缺失维度，不回显全文 |
| PostgreSQL 写入失败 | 503 `VOC_PERSISTENCE_UNAVAILABLE` | revision 不提交 | 保留现有 overlay，可重试 |
| DB 连接/超时/权限/schema/deserialize 失败 | 503 typed error / snapshot `source-error` | 不读 static、不改 snapshot | 显示运行时数据不可用，告警 |
| 相同内容重复提交 | 200 | 无新 revision | 显示“内容未变化” |
| revision 并发冲突 | 服务端重试一次；仍冲突 409 | 不产生半写入 | 提示刷新后重试 |
| 数据库成功、dispatcher 暂不可用 | 200 + `pending` | revision 与 outbox 已提交 | 数据立即显示，附“静态投影待同步” |
| 租户限定 GET 成功但部分 0 rows | 200 | 无 | 仅通过 owner eligibility gate 的缺失 ASIN可用 stale legacy fallback |
| legacy default org 或 owner manifest 缺失/无效 | 200 + missing | 无 | 禁用 static，显示尚未录入 |
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
- 超过 10 个：本次 add/paste/replace action 整体 reject，原草稿原样保留并显示 `too-many`；不得截取前 10 个、不得部分落地、不得静默丢弃。
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

Agent PostgreSQL `projects` 是所有**新项目**的权威源。执行边界继续使用认证后的 31901 project/run API；只有 Agent project 创建成功才存在 committed project。响应必须回显 project id、organizationId、marketplace 和 ASIN 顺序，客户端逐项核对后才能提交 run。

新 project 请求必须带 HTTP `Idempotency-Key` header，schema 固定为 16–128 个 ASCII `[A-Za-z0-9._:-]` 字符；缺失或无效返回 400。服务端以规范 payload `{name, marketplace, orderedAsins}` 计算 request hash，并在 `project_creation_idempotency(organization_id, idempotency_key, request_hash, project_id, created_at)` 持久化唯一 `(organization_id, idempotency_key)`：同 key + 同 hash 原样回放原 project；同 key + 不同 hash 返回 409 `IDEMPOTENCY_KEY_REUSED`；不同组织可使用相同 key 且互不可见。project 插入和 idempotency row 必须同事务提交。

项目列表、读取和创建全部从会话 principal 取得组织；不得接受查询参数选择其他组织。member 可以创建自己的分析组合；删除、跨用户管理或组织级维护继续遵循既有角色策略。

文件型收藏元数据只作引用，按 principal 的 organization 分区存储，至少包含 `{organizationId, agentProjectId, kind, slug, labels}`，不得复制成另一个可变 ASIN 权威源。其创建必须以 Agent project 已成功为前提并引用相同 project id；每次 list/get 都同时核对 principal organization 与 Agent project organization。收藏写入失败只影响收藏展示，不得回滚或改写已创建的 Agent project/run；页面提供可重试的“保存到收藏”。

### 8.8 迁移与兼容

本切片无需新增草稿数据库表；草稿是客户端短生命周期状态。需新增 project creation idempotency 表并收紧 project ASIN scope，但不批量修改现有项目。

已有 Agent 项目照原样读取并视为 immutable scope；现有同 ASIN 多项目全部保留。历史文件项目若没有 Agent project，只能进入以下显式路径之一：

1. 文件记录有可验证 organization owner 且等于 principal：以只读 legacy 映射打开；用户点击“导入为新组合”后，以新 id + 新 Idempotency-Key 创建 Agent project，成功后再创建分区收藏引用。
2. 文件记录没有 owner：只允许一次性绑定到有效 `LEGACY_PROJECT_DEFAULT_ORGANIZATION_ID`；该配置必须对应存在且有 active user 的组织，缺失/无效则隔离不可见。不得根据当前访问者自动认领。
3. owner 不等于 principal：返回 404，不能泄露项目存在。

旧页面 URL、slug 和 `asins` 继续可打开，但 slug 解析也必须经过上述 owner gate。新 reducer 上线前后的状态不做 localStorage 自动迁移，避免错误恢复旧 `activeAsins`。

## 9. 切片三：SIF 严格响应与有界关键词降级

### 9.1 规范输出

把现有只有 `asin` 的记录扩展为带证据层级的不可混淆结构：

```ts
type KeywordEvidenceMode =
  | "target-canonical"
  | "target-parameter-retry"
  | "parent-listing"
  | "category-proxy";

type CategoryEvidence = {
  provider: "catalog" | "sorftime";
  providerVersion: string;
  schemaVersion: string;
  targetAsin: string;
  categoryId: string;
  fetchedAt: string;
  payloadHash: string;
};

type RelationshipEvidence = {
  provider: "catalog" | "sorftime";
  providerVersion: string;
  schemaVersion: string;
  targetAsin: string;
  parentOrMainAsin: string;
  relationship: "parent" | "main-listing";
  fetchedAt: string;
  payloadHash: string;
};

type SifKeywordEvidence = {
  organizationId: string;
  jobId: string;
  targetAsin: string;
  marketplace: string;
  mode: KeywordEvidenceMode;
  lookupAsin: string | null;
  categoryId: string | null;
  relationshipEvidence: RelationshipEvidence | null;
  categoryEvidence: CategoryEvidence | null;
  queryVariant: string;
  paramsHash: string;
  queryWindow: SifKeywordQueryWindow;
  schemaVersion: string;
  providerVersion: string;
  fetchedAt: string;
  status: "ready" | "empty" | "unavailable" | "schema-error" | "quota-blocked";
  terminalReason:
    | "valid-empty" | "capability-unknown" | "provider-unavailable"
    | "schema-invalid" | "identity-unverified" | "category-unverified"
    | "quota-floor" | "physical-attempt-limit" | null;
  keywords: readonly SifKeywordRecord[];
  attempts: readonly KeywordAttemptSummary[];
  crossValidation: readonly CrossValidationFact[];
};
```

`targetAsin` 永远是用户 committed scope 中的 ASIN。`lookupAsin` 是 SIF 实际接收的 ASIN；类目代理时为 null。`mode` 在所有 status 下都有定义：ready/empty 表示已严格验证的证据层，unavailable/schema-error/quota-blocked 表示链路停止时正在尝试的层级，必须与 terminalReason 一起解释，不能被当作可用数据。UI 和下游分析按 `status + mode` 决定语义，不允许通过 `record.asin = targetAsin` 丢失 provenance。

`ready` 要求 keywords 非空且 terminalReason 为 null；`empty` 要求 strict-valid 空响应和 `valid-empty`；`unavailable/schema-error/quota-blocked` 的 keywords 必须为空，分别使用允许的不可用、`schema-invalid`、`quota-floor`/`physical-attempt-limit` reason，不能携带可供分析的残留数值。

`KeywordEvidenceRepository` 是运行时权威源，持久化 key 为 `(organization_id, job_id, marketplace, target_asin, mode, lookup_asin_or_empty, category_id_or_empty, params_hash, schema_version, provider_version)`；attempt 与每次物理 HTTP receipt 另表追加保存。stage 只把成功提交 repository 的 evidence id 发布为 output。`app/sif-keyword-analysis-data.ts` 是可重建的全局兼容投影，不参与运行时正确性，也不得跨组织被 run 读取。

### 9.2 严格 schema

每个 allowlist SIF operation/version 都有独立的严格输入和响应 adapter：

- 顶层对象、分页、keyword 行和数值范围使用 strict schema；
- keyword 必须为非空字符串；比例、搜索量、排名和竞价只接受合同允许的 number/null，不把任意字符串强转成 0；
- `target-canonical`、`target-parameter-retry` 和 `parent-listing` 才允许 listing traffic share / organic rank；
- `category-proxy` schema 不包含目标 listing traffic share 或目标 organic rank 字段；
- 结构漂移、关键字段错型或 ASIN 回显不匹配返回 `schema-error` 并 fail closed；不得把畸形响应继续送入下一降级级别。

替代参数不是运行时猜字段。实现维护一个版本化 allowlist registry，每个 entry 固定 tool name、语义字段到 provider 参数的映射、适用 connector capability version 和响应 schema。启动时从 connector capabilities 选择一个已测试 entry；provider/capability version 缺失或未知时只允许降级到已验证的最低兼容 entry，若没有明确兼容声明则返回 `unavailable + capability-unknown`，不能假定最新 schema。

stage dispatcher 启动子进程时必须完整传递 `organizationId、jobId、projectId、runId、marketplace、ordered targetAsins、dataCutoffAt、provider/schema version、quota policy id`，worker 启动后从 repository 反查并逐项验证。任一 scope 缺失或不一致立即失败，禁止退回环境默认组织、全局 catalog ASIN 或全局 TS 输出。

### 9.3 降级顺序

对每个 target ASIN 固定执行：

#### Level 1：目标 ASIN，canonical 参数

调用当前 `market_get_asin_keyword_signals` 近 30 天 listing scope。严格有效且非空即结束，mode 为 `target-canonical`。

#### Level 2：目标 ASIN，替代参数重试

只有 Level 1 返回明确的 `INVALID_ARGUMENT` 或 `UNSUPPORTED_PARAMETER`，且 capability registry 为当前 provider version 提供了另一条**已测试、语义等价**参数映射时才执行一次。超时、鉴权失败、配额不足、5xx、schema-error 和有效空结果都不触发参数重试。

成功 mode 为 `target-parameter-retry`，`lookupAsin === targetAsin`。有效空结果进入 Level 3。

#### Level 3：已验证父体/主 Listing ASIN

仅当目标查询得到严格有效空结果，或 provider 明确表示该子体不可按 listing 查询时使用。父体/主 Listing 必须来自目标商品自身的可信关系字段：

1. 已持久化 catalog/variant 数据中明确的 `parentAsin` / `mainListingAsin`；或
2. Sorftime `product_detail` 对**同一 target ASIN**返回的明确父子/主 Listing 字段，并通过专用 strict schema。

只凭标题、品牌、类目、图片或相似度推断的 ASIN不合格。候选必须是不同于 target 的合法十位 ASIN，并保存 relationship evidence 的 provider、providerVersion、schemaVersion、fetchedAt、target、parent/main、payloadHash 字段。

随后以已验证 ASIN执行一次 SIF canonical 查询。成功 mode 为 `parent-listing`；UI 固定显示“父体/主 Listing 关键词，非目标子 ASIN 独立流量”，所有流量占比和排名归属于 `lookupAsin`。

#### Level 4：类目代理关键词

仅当前三级都没有可用严格结果，并且目标 ASIN具有可信 browse node/category id 时执行。`categoryEvidence` 必须记录 provider、provider/schema version、targetAsin、categoryId、fetchedAt 和 payloadHash。调用 capability registry 中 allowlist 的 SIF 类目关键词 operation；repository 对 `(organizationId, jobId, marketplace, categoryId, paramsHash, schemaVersion, providerVersion)` 建立唯一键，使同一 job 的类目调用可事务去重并共享结果，而不是依赖进程内 Map。

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
organizationId / jobId / marketplace / targetAsin / mode / lookupAsin-or-categoryId /
paramsHash / schemaVersion / providerVersion
```

每个 target ASIN 的 **SIF 物理 HTTP receipt 硬上限为 3**，connector 内网络重试、canonical、替代参数、父体和类目调用统一计数；不是每个逻辑 level 各有三次。典型链为 canonical → parent → category，或 canonical 参数拒绝 → alternate → parent，到达 3 后以 `physical-attempt-limit` 终止。共享类目 receipt 通过 repository 唯一键每 job 每类目最多生成一次，但只有尚有 target receipt 预算的 ASIN可引用。Sorftime 关系验证另受现有 governor 管理且每 target 最多 1 次，已有新鲜 catalog relationship 时为 0 次。

关键词 enrichment 只对最终展示的去重 top N 关键词执行，默认 N=50；缓存至少按 organization、marketplace、keyword、参数/schema/provider version 与时间窗隔离，job evidence 只保存所引用 cache revision。调用前通过现有 resource governor / quota ledger 预约额度，低于组织保留阈值时停止后续 fallback，返回 `quota-blocked + quota-floor`，不得透支后再报错。

重试规则：

- 参数替代属于一次有意的兼容尝试，不属于网络重试。
- 网络瞬时重试沿用 connector 的统一策略，但每次实际 HTTP 发送必须先生成 receipt 并计入同一 target 的 3 次硬上限；无剩余额度时 connector 不发送重试。
- 401/403、schema-error、明确 quota error 不重试。
- 每次 logical attempt 与每次 physical receipt 分别记录 provider、operation、provider/schema version、paramsHash、reason、mode、耗时、quota receipt 和脱敏 error code；不得记录密钥或完整原始响应。

### 9.6 UI 与下游分析

关键词卡片必须读取 `KeywordEvidenceRepository` 投影并按 status + mode 显示 badge 和 terminalReason；static TS 只能在明确 legacy 模式下显示 stale badge。排序/对比规则：

1. target 两种 mode 可以在目标 ASIN间做同口径流量对比；
2. parent-listing 只在相同 queried listing 语义下单列，不与子体 target 流量直接排名；
3. category-proxy 只进入需求发现，不进入竞品 ASIN 流量份额图；
4. cross-validation 只作为旁证，不改变 SIF 数值。

严格 schema/provenance 必须贯穿 adapter → stage output → Agent API → UI → export → product definition；任何一层缺少 organization/job/scope、status、mode、lookup identity、params/schema/provider version 或 evidence id 都 fail closed。下游 VOC 定位或产品定义若消费关键词，必须收到完整 provenance。没有 target 数据时可以引用“父体关键词”或“类目代理需求”，但结论文字必须保留限定词，不能写成“该 ASIN 的核心流量词”。

## 10. 跨切片一致性、并发与安全

### 10.1 组织与站点

- Manual VOC、project、run、keyword evidence 和缓存都以认证 principal 的 organizationId 为首要隔离维度。
- marketplace 由单一 `MarketplaceSchema` 真实 allowlist 校验；首发明确为 `US`，不是“任意两个大写字母”。未来增加站点必须同时得到 Agent 配置、SIF/Sorftime capability 和 UI allowlist 的交集，并通过独立测试后发版。
- Web 不从请求 body 信任 organizationId；内部服务也必须复核 project.organizationId。
- 静态全局 fallback 只能服务存在且有效的 `LEGACY_VOC_DEFAULT_ORGANIZATION_ID`，并通过 owner manifest gate；配置缺失、指向不存在/无 active user 的组织、marketplace 不匹配或 owner 缺失时一律禁用，不能泄露到其他组织。

### 10.2 不可变运行

运行创建时冻结：organization、marketplace、ASIN 顺序、project id、dataCutoffAt 和各数据 snapshot。之后的 Alexa revision、草稿编辑、SIF cache refresh 或 Sorftime验证只影响新运行。

### 10.3 请求幂等

- Alexa：以当前 head content hash 实现内容幂等。
- 新组合：以组织 + Idempotency-Key 幂等创建；相同 key 不得创建两个项目。
- run：沿用组织、project、idempotency scope/key；双击只创建一个 run。
- SIF：以 immutable query/cache key 和 governor receipt 去重；同 job 不重复消费类目代理额度。

### 10.4 敏感信息

新导入的原始 Alexa 报告只以应用层加密密文存数据库；不再写新的明文 `data/alexa-voc-cache/<ASIN>.txt`，既有 legacy cache 不删除但只读、仅受固定 owner gate 访问，并纳入原文保留/清理审计。原文不进入 GET 响应、日志、错误、Artifact manifest 或 telemetry。SIF/Sorftime密钥、headers、原始响应和数据库 URL 同样不得记录。日志只包含组织哈希/内部 id、ASIN、revision、mode、状态码和耗时。

## 11. 可观测性

### 11.1 Manual Alexa VOC 指标

- `manual_alexa_voc_write_total{result=new|updated|idempotent|rejected|failed}`
- `manual_alexa_voc_read_total{source=postgres|legacy_static|missing|schema_error}`
- `manual_alexa_voc_overlay_lag_ms`：POST capturedAt 到页面确认时间
- `manual_alexa_voc_cutoff_excluded_total`
- `manual_alexa_voc_publication_total{status=pending|leased|applied|failed|disabled}`
- `manual_alexa_voc_publication_lag_seconds`
- `manual_alexa_voc_outbox_total{status=pending|leased|applied|failed}`
- `manual_alexa_voc_stale_epoch_response_dropped_total`
- `manual_alexa_voc_legacy_gate_total{result=allowed|owner_mismatch|owner_missing|config_missing}`

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
- `sif_keyword_physical_receipt_total{provider_version,mode,result}`
- `sif_keyword_attempt_limit_total`
- `sorftime_keyword_verification_total{purpose=relationship|category|trend,result}`

告警优先级：跨组织读取或同 revision 不同 hash 为最高；持续 schema-error、动态读取回退率升高、publication 长期滞后和 quota-blocked 突增为运维告警。

## 12. 分阶段发布顺序

实施文档必须分别生成：Plan 01 仅覆盖 Phase 0 中 Manual VOC 相关迁移及 Phase 1A/1B；Plan 02 仅覆盖 Phase 2；Plan 03 仅覆盖 Phase 3。Plan 02 只能依赖 Plan 01 已发布合同，Plan 03 只能依赖 Plan 02 的 committed scope；不得把后续切片任务塞回前一 plan。

### Phase 0：合同与迁移预备

- 新增 repository interface、严格 schemas、向前 migrations 和 feature flags。
- 在 CI 的 SQLite/PostgreSQL migration 测试验证全新安装与已有数据库升级。
- 默认所有新读写开关关闭；不触碰现有运行服务和静态数据。

### Phase 1A：Manual VOC 双投影写入

- 打开 PostgreSQL 权威写开关；导入必须先成功提交 DB。
- 同事务写 publication outbox；legacy cache/TS/Artifact 由 dispatcher + periodic reconciler best-effort 执行。
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

- 先上线 scoped `KeywordEvidenceRepository` 与完整子进程 scope，shadow 解析当前响应但不改变 UI；确认 strict schema 覆盖率。
- 开启 canonical + 参数替代，再开启 verified parent/main listing。
- 最后开启 category proxy 和 Sorftime cross-validation badge。
- 每级都有独立开关和额度上限，可单独关闭，不影响前两切片。

## 13. 回滚

### 13.1 Manual VOC

- 页面 overlay异常：关闭 UI dynamic read；只有 owner gate 合格时才显示明确标注 `stale legacy fallback` 的静态值，不能声称实时正确；PostgreSQL revision 保留。
- 31901 动态 source 异常：停止创建依赖实时 VOC 的新 run 并返回 503；只有经 owner gate 且业务明确接受 stale 时才可创建标注 legacy 的运行，默认不自动恢复 static。
- publication 异常：关闭 best-effort publisher，不回退权威 DB 写入。
- 只有数据库本身不可用时，导入明确返回 503；不得静默回到仅写静态文件并返回成功。
- 恢复 publication 时从 heads + revisions 重建 outbox/投影/owner manifest，不信任旧生成文件反向覆盖数据库。

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
9. heads 复合 FK 拒绝 revision/hash/capturedAt 任一不一致；bigint 往返 API 不经过 number。
10. createdBy 与 organization 不一致、disabled user 或不存在 user 的事务全部拒绝。
11. `octet_length` / byte length CHECK 拒绝超过 131072 UTF-8 bytes；缺 active key 时零写入 503；密文 key rotation、访问 audit 和 365 天原文清除策略可验证且不改变/删除 normalized revision。
12. import 与 `createRunWithVocSnapshot` 并发的两种提交顺序均线性化：import 先提交则 snapshot 含新 revision，run 先提交则只在下一 run 可见；cutoff 与 selected revision 来自同一 DB transaction/clock。

### 14.2 Manual VOC API/UI 测试

1. 缺 session Cookie、内部 proxy token、trusted Origin 任一项，以及角色不足请求，均在解析/写库前拒绝；代理复用 `createAgentServiceClient`。
2. `text` 与 `rawText` 各自兼容；同时出现/都缺失拒绝。真实七问格式 7/7 导入后响应含字符串 revision/hash/capturedAt/normalizedRecord。
3. 前端收到 POST 后无需 Artifact rebuild 即更新对应矩阵列。
4. 页面刷新后 GET 恢复相同 revision；过时 GET 不覆盖新 POST。
5. dispatcher 不可用时响应仍为 DB 成功 + outbox pending，页面显示数据和“静态投影待同步”。
6. 31901 不重启，新建 VOC 独立分析 run 能读到导入 revision。
7. 导入晚于旧 run cutoff 时旧 snapshot 不变；新 run 读取新 revision。
8. 非 legacy default organization 不生成全局静态 TS 数据。
9. session/org identity 切换递增 epoch、清空 cache/overlay；旧 epoch 延迟响应不能落地。
10. DB success + 0 rows 才调用 static gate；连接、timeout、permission、schema 和 deserialize fixture 都返回 typed 503/source-error 且 static spy 未调用。
11. owner org/marketplace/generation manifest 有效时 Web 与 31901 同判可读；无 owner 仅能一次绑定固定 legacy org，配置缺失时两端都禁用。
12. commit 后 dispatcher 崩溃由 outbox reconciler 补排；同内容幂等重试能补建 missing/failed outbox；重建保留每 ASIN 精确 capturedAt 和 owner。
13. CreateRun body 含 `dataCutoffAt` 被 strict schema 400 拒绝。

### 14.3 Draft reducer 与集成测试

1. 0、1、2、3、10 个 ASIN都可编辑；第 11 个 add/paste/replace 整体 reject、原草稿不变并显示 too-many；clear 得到真正空草稿。
2. invalid/duplicate 保留在 UI，保存/运行拒绝且没有 API side effect。
3. 每个 tab 的保存和运行使用同一个 frozen snapshot。
4. dirty draft 默认创建新 project；相同 ASIN 的旧 project 不被静默复用。
5. clean project 可创建新 run，旧 run/snapshot/report 不变。
6. 请求期间继续编辑时，旧响应不把新 draft 标记 clean。
7. project/run hydrate 的旧异步响应不覆盖新 navigation 或用户输入。
8. legacy `asins` URL、slug、project/run 和 0–2 个 `draftAsins` 均按规定恢复。
9. PATCH ASIN scope 返回 409；元数据 PATCH 仍兼容。
10. Agent PostgreSQL project 是新项目权威；文件收藏只保存同 principal organization 的引用，不能独立改变 ASIN scope。
11. `Idempotency-Key` 缺失/格式错误 400，同组织同 key+同 payload 回放，同 key+不同 payload 409，不同组织互相隔离；重启后仍由持久化唯一键保证。
12. 无 Agent project 的 legacy 文件：owner 相同只能只读并显式导入为新 project；owner 不同返回 404；无 owner 且默认组织缺失时隔离不可见。

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
11. `KeywordEvidenceRepository` key 包含 organization/job/marketplace/target/mode/lookup/category/params/schema/provider version，stage 子进程缺任一完整 scope 均 fail closed。
12. ready/empty/unavailable/schema-error/quota-blocked 都保留已定义 mode；terminalReason 与 categoryEvidence 通过 Agent API、UI、export、product definition 原样贯穿。
13. unknown capability version 只使用 registry 明确声明的兼容 entry，否则 `unavailable + capability-unknown`。
14. 包括 connector 网络重试在内，每 target 最多产生 3 个物理 SIF HTTP receipts；第 4 次发送被 repository/governor 阻止。
15. 相同 job/category 的并发请求只产生一个类目 receipt；全局 TS 损坏或跨组织数据不影响 runtime repository 读取。

### 14.5 端到端验收场景

1. 用户打开含 3 个子 ASIN 的组合，给其中一个粘贴 7/7 Alexa 报告。
2. 导入响应成功后使用可控 `eventually` polling 验证该列显示 PostgreSQL revision badge：测试环境 fake clock 每 100 ms 推进，最多 20 次；真实隔离端口环境间隔 250 ms、deadline 5 秒并输出最后一次状态，不使用固定 sleep；不等待 build。
3. 不重启任何服务，点击 VOC 独立分析；新 run snapshot 包含该 revision，cutoff 不早于 capturedAt。
4. 把草稿删到 2 个，页面允许继续编辑但运行按钮给出边界错误；重新加到 3 个后运行。
5. 新运行创建新组合，不修改步骤 1 的项目或任何旧报告。
6. 某目标 SIF canonical 返回有效空结果：若有验证父体则显示父体 badge；无父体但有类目则显示类目代理；两者都没有则显示明确缺口。
7. 页面和导出的报告均不会把父体、类目或 Sorftime旁证描述成目标 ASIN 流量。

## 15. 验收标准

只有同时满足以下条件才算完成：

- Manual Alexa VOC 的成功语义由 PostgreSQL commit 决定，页面和 31901 均动态读取同一 revision。
- 每条动态记录具有同一 DB clock 的精确 UTC capturedAt、字符串 bigint revision、含 parser/schema version 的 SHA-256 hash、head 复合 FK 和组织/站点隔离。
- 所有 runtime VOC key 包含 organization/marketplace/ASIN 与 sessionOrgEpoch；身份切换后旧响应无法落地。
- static TS/publication 失败不阻止即时矩阵或新 VOC 独立分析，且 legacy fallback 仍可受控回滚。
- run cutoff、revision selection 和 snapshot 在一个 DB transaction 完成；客户端不能指定 cutoff。
- 用户可编辑 0–10 个 ASIN；保存/运行只接受 3–10 个合法唯一 ASIN。
- `inputs`、`asinDraft`、`activeAsins` 不再作为三个可变业务真相；所有动作消费同一冻结 snapshot。
- 默认另存新组合；历史 project/run/snapshot/report 未被更新或删除。
- Agent DB 是新 project 权威，文件收藏只有组织分区引用；Idempotency-Key 冲突语义持久化且可重放。
- SIF 每级响应严格校验，fallback 有界、有额度记账、有 provenance。
- KeywordEvidenceRepository 是运行时权威；每 target 包括网络重试最多 3 个物理 SIF receipts，全局 TS 仅为投影。
- parent/main listing 和 category proxy 在 UI、API、缓存和下游分析中均不能冒充 target ASIN。
- Sorftime 只作交叉验证，不能写入 target SIF traffic 字段。
- 定向测试、全量测试、lint、typecheck、fresh build、SQLite/PostgreSQL migration test 和隔离端口 E2E 全部通过。
- 部署和人工验证不得启动第二套 Web、不得监听 3000、不得替换 31901/58258，也不得包含用户现有生成数据 WIP。

## 16. 实施文件责任边界

以下是责任范围，不是要求一次提交全部修改：

| 范围 | 主要责任 |
| --- | --- |
| `server/db/migrations/*`、`server/db/migrations/postgres/*` | Manual VOC heads/revisions/outbox/audit、project idempotency、keyword evidence/receipts 向前迁移 |
| `server/db/*repository*` | 租户隔离、revision/FK/outbox、原子 run cutoff、project idempotency、keyword evidence/receipt |
| `server/routes/*`、`shared/agent-contracts.ts` | Manual VOC、project/run 与严格错误合同 |
| `server/data/repository-voc-source.ts` | PostgreSQL-first 动态 VOC + legacy fallback |
| `app/api/alexa-voc/*`、`app/alexa-voc-import-panel.tsx` | 同源代理、POST overlay、publication 非阻塞提示 |
| `app/page.tsx` 及拆出的 reducer/selectors | `comparisonDraft`、`committedScope`、统一动作 snapshot、矩阵 overlay |
| `scripts/build-sif-keyword-analysis.mjs`、`scripts/lib/sif-*` | 完整 job scope、strict adapter registry、有界 fallback、provenance、quota/receipt/cache |
| `app/sif-keyword-analysis-data.ts` 的生成合同及消费者 | legacy 投影；runtime 读取 repository，mode/target/lookup/category badge 与下游限制 |
| tests | repository、API、UI reducer、provider fixtures、迁移、E2E 与回归 |

## 17. 自检结论

- **未决项：** 无。参数替代通过版本化 allowlist registry 绑定已测试 connector contract，不留运行时猜参事项。
- **顺序：** 明确为 PostgreSQL Manual VOC → `comparisonDraft` → SIF fallback；三个切片可独立开关和回滚。
- **交付粒度：** 三个独立 subproject/plan 依序交付，不形成跨域巨型实施计划。
- **租户闭环：** runtime key、session epoch、owner manifest、legacy default org、Web/31901 gate 和旧响应丢弃均有完整合同。
- **权威源：** Manual Alexa VOC 与 Keyword evidence 分别只有 PostgreSQL repository 一个运行时权威源；静态 TS 是 stale legacy 投影，不存在双主冲突。
- **时间语义：** capturedAt 为 head lock 后同一 DB clock；run cutoff、revision selection 与 snapshot 同事务，旧 run 不变，外部不能提交 cutoff。
- **错误语义：** 只有租户查询成功 0 rows 才评估 legacy；连接、权限、schema、deserialize 等失败均 typed fail closed。
- **发布语义：** revision 与 outbox 同事务，dispatcher/reconciler 可补排；回滚只可显示 owner 合格的 stale 数据或从 heads 重建。
- **历史语义：** Manual VOC revision、project、run、snapshot 和报告均不删除、不覆盖；草稿变化默认创建新组合。
- **项目语义：** Agent DB 为新 project 权威，持久化 Idempotency-Key 冲突合同；文件收藏只作组织分区引用，unowned legacy 不自动认领。
- **来源语义：** target、parent/main、category proxy、Sorftime cross-validation 四类不能互相冒充。
- **范围：** 不包含 provider 迁移、自动 Alexa 抓取、历史删除、全量收藏存储迁移或多站点扩展。
- **成本：** SIF/Sorftime 调用有硬上限、共享缓存、quota floor 和 receipt；publication 不影响业务成功。
- **回滚：** 每个切片均可通过独立开关退回上一读路径，数据库迁移只向前且保留所有新增历史数据。
