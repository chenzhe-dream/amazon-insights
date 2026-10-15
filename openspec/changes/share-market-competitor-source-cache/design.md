## Context

用户已批准按 150 个市场商品和 10 个竞品验证，保持全部现有分析内容。两条调用链都进入 scripts/lib/sorftime-mcp-client.mjs，但市场 connector 使用独立的 env 和外层治理，必须一并接通。已有任务内缓存继续保留。

## Goals / Non-Goals

目标：共享相同 Sorftime 原始请求，包含进程重启后的缓存与跨进程同时请求；保留原始时间和独立报告证据。预算只表示估计单位，不声称实际扣费。
非目标：更换数据供应商、降低 150 样本、把美国数据翻译后当德国数据、自动发布正式环境、把 Customers Say 当原始评论。SellerSprite/SIF 本次不套用 Sorftime 费率。

## Decisions

- 使用现有 PostgreSQL，新增独立缓存/额度暂停/访问事件表。相比进程 Map 或工作目录文件，数据库能覆盖 Agent 与采集子进程并在进程退出后释放会话 advisory lock。
- 在 common Sorftime tool client 接入，完整 canonical 参数、endpoint 和凭据散列构成 key；不带 jobId。相同服务凭据的公开商品数据复用，鉴权仍先于 client 执行。不同凭据不共享。
- 正常 TTL：趋势/类目/商品池/关键词 24 小时，详情/变体 6 小时，内容图片 7 天，评论 24 小时。已确认空结果 5 分钟；网络失败不进入成功缓存。仅明确支持的只读接口缓存。
- 已保存报告只读保持不变；缓存重用不把 fetchedAt 改成当前时间。原始响应可由修复后的解析器重放，不持久化消费者报告结构。
- 额度耗尽在同凭据下暂停 1 小时，仍允许读有效缓存；提供明确清除暂停的运维方式。错误不保存供应商原文。冷请求拿到额度错误后不继续同调用重试；已经在途请求无法撤销。
- 缓存默认由 SORFTIME_SOURCE_CACHE_ENABLED=1 启用并要求 AGENT_DATABASE_URL。不可用时明确失败，不静默付费直连。候选与正式数据库隔离。
- 所有物理尝试在实际 dispatch 前写事件；命中缓存记独立事件。提供按请求清单去重与缓存命中的预算方法。公式不依赖固定 150/10，测试使用该规模。
- 图片详情还提供毛利率，保留现有步骤，先通过共同缓存节省；不盲目删掉详情或用主图替代完整图库。

## Risks / Trade-offs

- 锁等待 → 轮询可取消，数据库连接断开即释放锁；失败短暂退避防止等待者紧接着再次付费。
- 供应商 API 错误包装 → 明确拒绝 isError/error/success=false/非成功 code；schema-invalid 原始数据不用于伪造成功结果。
- 超时和重试 → 保留原有治理上限，缓存入口置于物理治理之前；禁止额外外层网络重试放大。
- TTL 内结果可能过时 → 提供显式强制刷新，缓存记录原采集时间。

## Migration Plan

新增 0067 migration；先红灯测试，再实现政策、数据库缓存、公共客户端接入、connector 原始时间兼容；运行 150+10、跨进程、隔离、失效、取消、错误及额度暂停测试。最后 typecheck 和现有采集回归。32900 开关启用前核实迁移；31900 等用户验收。本次不自动归档。

## 2026-10-14 第二阶段：SellerSprite 与 SIF

用户依据全流程审计批准扩展共享缓存并离线计数，明确不发布 31900。复用现有数据库缓存引擎及 0067 表（历史名称保留），避免重复维护锁、暂停和刷新逻辑。Sorftime 旧 key 不变；新增供应商独立 identity 命名空间，事件 operation 使用 `sellerSprite/tool` 或 `sif/tool`，未知费率保留 null。不需要修改已执行 migration。

在 SellerSprite/SIF 公共 tool client 接入，跨 server/CLI 生效。仅显式登记只读工具缓存，未知工具旁路；普通结果 24 小时，SellerSprite 详情和利润补充 6 小时，明确空数组 5 分钟。`SHARED_MCP_SOURCE_CACHE_ENABLED=1` 独立控制新供应商缓存，必须配置 AGENT_DATABASE_URL；Sorftime 开关不变。显式 `FORCE_REFRESH`/`--force` 与既有 job refresh scope 生效，缓存读不占物理并发和额度。

实施顺序：新增真实客户端失败测试 → 参数化缓存政策、接入客户端和治理 → 保留报告来源时间 → 全链路虚拟 HTTP 供应商对比 → 类型、采集脚本和 connector 回归。通过测试后记录实测计数，运行环境是否启用单独报告。补充额度后可用 `SOURCE_CACHE_PROVIDER=sellerSprite|sif` 配合现有 source-cache-admin 的 resume，命令不触发采集。
