# SellerSprite / SIF 共享缓存：离线验证

## 实现与交付范围

用户授权先补共享缓存、复跑虚拟数据，不发布 31900。本次修改在候选 worktree，未重启或更新 32900/31900，也未向供应商或大模型发送真实请求。

SellerSprite 和 SIF 的 server connector、采集 CLI 现在共用 PostgreSQL 原始响应缓存。沿用 0067 历史表名及锁/刷新/失败暂停逻辑，无新增 migration，不改变现有 Sorftime key。新供应商用独立 key 命名空间和事件 operation 前缀，不能跨供应商、凭据、站点、月份、分页或其他参数混用数据。

- 仅显式登记的只读工具进入缓存；未登记工具不持久化。
- 默认 24 小时；SellerSprite 详情及利润补充 6 小时；明确空结果 5 分钟。
- 同请求并发合并、跨进程/重启复用；网络/业务失败不写成功缓存，失败退避 5 秒，明确额度耗尽暂停该凭据 1 小时。有效缓存仍可读取。
- 保留原采集时间；市场报告来源时间和 SIF 关键词/流量生成记录取来源时间，不把命中缓存的时间当成采集时间。
- 显式强制刷新与已有 job refresh scope 仍生效；强制刷新失败不覆盖原成功数据。
- 缓存命中不申请物理请求额度；SellerSprite 握手仍受原治理约束，但不算业务取数。SellerSprite/SIF 不套用 Sorftime 费率。

## 同样虚拟数据的调用对比

使用 US 虚拟类目 12:34、2026-07 至 2026-09，四模块默认 100 商品后扩到 150，竞品取其中 10 ASIN。每个竞品一个变体、两个共享关键词。新一轮将三个供应商全部改为本地 HTTP 模拟服务，走实际公共客户端；优化前 SellerSprite/市场 SIF 使用直接注入的同样业务响应。计数均为业务 tools/call，不包含握手探活。

| 场景 | 优化前 | 优化后 | 减少 |
| --- | ---: | ---: | ---: |
| 四模块默认 100 商品 | 379 | 378 | 1 |
| 形态扩至 150 | 153 | 153 | 0 |
| 首次分析其中 10 个竞品 | 82 | 81 | 1 |
| 首轮累计 | 614 | 612 | 2 |
| 读取已保存报告 | 0 | 0 | 0 |
| 重复执行竞品采集 | 0 | 0 | 0 |
| 有效期内新建相同市场批次 | 47 | 0 | 47 |

首轮供应商分布：Sorftime 525→525，SellerSprite 46→45，SIF 43→42。首轮消除一条重复 `market_research` 和一条市场/竞品间重复 `market_get_keyword_history`。缓存主要节约重复分析；首次缺失的数据仍必须采集。累计首轮加一次同条件市场重跑：661→612，减少 49 次。

该数量只适用于本次固定样本，不能作为真实类目的固定费用。报告时间/站点/参数变更、超过 TTL、显式刷新都会产生新的必要请求；实际供应商扣费尚未核验。

## 验证证据

- 全链路最终复跑 1/1 通过，约 280 秒，复核后计数保持一致。首次和第二轮四个模块均 succeeded；150 商品报告成功；12 个竞品采集脚本各执行两轮，24 次全部正常退出。
- 缓存、connector 治理及 Sorftime 回归最终 52/52 通过，包含空结果、刷新失败、无业务内容的 MCP envelope、本地排队拒绝及恢复。
- 会话池、SIF 解析、供应商诊断/降级回归 64/64 通过。
- TypeScript 类型检查、git diff --check、OpenSpec strict validate 通过。
- 新缓存测试已先验证失败：并发重复调用和跨子进程重复调用；接入后通过。
- 独立只读审核发现并修复两项：拒绝将 `content: []` 缓存为成功响应；本地治理拒绝/取消直接透传，不写供应商失败暂停。补充失败测试后复核无新增阻塞问题。

固定计数证据：`shared-provider-cache-counts-20261014.json`。详细本地日志：`.runtime/shared-provider-full-flow-final.log`、`.runtime/shared-provider-regression-final.log`、`.runtime/shared-provider-script-regression-final.log`。全量虚拟响应明细在 `.runtime/market-competitor-offline-dispatch-audit.json`。

离线流程不替代浏览器验收、完整 sync-job 状态发布、SellerSprite 主底库/西柚分支或真实费用核验。原先的商品详情缺字段补采、SIF 按单词拆分批次复用、新鲜度统一仍属于后续优化，本次没有把它们计为已完成。

## 候选启用说明（本次尚未执行）

先确认目标数据库已安装 0067，再给 Agent 与采集子进程配置 `SHARED_MCP_SOURCE_CACHE_ENABLED=1` 和同一个目标 `AGENT_DATABASE_URL`；Sorftime 保留自己的开关。数据库不可用时不会静默绕过缓存付费直连。已有候选的 Sorftime 开关不会自动开启新供应商缓存。

运维计数仍用 `scripts/sorftime-source-cache-admin.mjs summary`。若补充额度后需清除暂停，设置 `SOURCE_CACHE_PROVIDER=sellerSprite` 或 `sif`，运行同一脚本的 `resume`；只清对应凭据的暂停，不触发采集。正式 31900 继续等待用户验收授权。

## 后续状态更新（2026-10-14）
联动历史恢复修复完成后，已在候选32900/32901启用 SHARED_MCP_SOURCE_CACHE_ENABLED=1 并重启核实版本。上文‘尚未执行’描述保留为前一阶段状态。最新真实页面与零新增采集证据见 linked-cache-repair-acceptance-20261014.md。31900未变更。
