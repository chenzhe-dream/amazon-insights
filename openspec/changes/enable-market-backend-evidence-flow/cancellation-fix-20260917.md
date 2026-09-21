# Market cancellation audit consistency — 2026-09-17

## Confirmed failure

Read-only inspection of isolated schema `market_live_20260917` confirmed overview `c7b9256e-9769-4b6b-b882-7a332297b0d4` was cancelled at `2026-09-17T01:34:50.044Z` while two model audits remained pending (two others were already failed). No business or acceptance data was modified by this fix's verification.

Cancellation previously changed the module, steps and step attempts and revoked execution leases, but left pending model audits open. The executing worker then could not finalize those audits because finalization requires an uncancelled module and a valid execution lease. Its fallback emitted `persistence-failed`. This was a cancellation transaction boundary defect; it was not evidence that another model request should be sent.

## Implemented behavior

- Cancellation and pending-audit terminalization now share the same PostgreSQL transaction and module lock. All pending audits in that module, including abandoned earlier attempts, become cancelled. Completed audit history remains unchanged.
- The terminal audit snapshots the existing ledger at cancellation. Dispatched but unsettled usage remains unknown/projected; no zero usage is invented. A late provider response may still settle the original ledger reservation, but cannot publish output or alter the immutable cancellation outcome.
- Concurrent completion and cancellation serialize on the module lock. If completion has committed, cancellation retains that history. If cancellation wins, late finalization remains fenced. Audit write failure rolls back module cancellation and step fencing together.
- The executing service may observe its exact persisted cancelled audit after a completion race, without regaining authority. The model worker emits `cancelled` instead of misreporting this expected outcome as persistence failure.
- Repeating an authorized cancellation also safely closes pending audits left by the prior implementation on an already cancelled module. This is explicit command repair; no automatic scan or production repair was run.

## Verification

New tests reproduced five failing scenarios before the implementation. The final cancellation suite passes 8/8 (seven subtests plus the parent), covering organization rejection, idempotency, denied late execution, completion/cancellation races, projected usage and late ledger settlement, completed-history preservation, transaction rollback, legacy orphan repair and worker events.

The existing semantic-execution cancellation test previously asserted the defect (pending audit after cancellation). It now asserts a terminal cancelled result, no published output and unchanged audit after late accounting. Semantic-execution suite passes 10/10. Other focused suites passed: market runtime 16/16, module execution store 18/18, native audit store 10/10. Full TypeScript check passed. Targeted ESLint passed after removing an unused type import.

## Files

- `server/db/postgres/market-agent-run-store.ts`
- `server/db/postgres/market-module-execution-store.ts`
- `server/runtime/market-semantic-execution-service.ts`
- `server/runtime/market-model-batch-worker.ts`
- `tests/agent/market-cancellation.test.ts`
- `tests/agent/market-semantic-execution-service.test.ts`

## Remaining boundary

The code does not retroactively mutate saved data without invoking the repairable cancellation command. The acceptance coordinator subsequently invoked the normal cancellation service on the already cancelled isolated run at `2026-09-17T01:58:15.992Z`; the receipt is `.superpowers/sdd/market-live-fix-20260917/old-overview-cancel-repair.json`. An independent read-only check confirmed two cancelled audits, the original two failed audits and no pending audits. No formal deployment, formal task cancellation, supplier call or paid model call was performed by this repair. Cancellation is a logical execution fence, not a guarantee that the upstream provider physically stops charging immediately. Late charges remain a ledger concern and the cancelled business outcome stays immutable.
# 真实验收补充：关键词取消后历史读取

2026-09-17 隔离验收 `market_live_acceptance_20260917` 的关键词任务
`e327f67f-815d-4842-b6af-1ce741e4f0c6` 在初始模型超时后已成功取消，
但紧接的 GET 抛出 `Keyword reconciliation flow lineage differs`。
原因不是 v2 被当成 v1：历史读取此前临时把 cancelled 状态替换成 partial，
而归并步骤仍是「取消前未领取、没有 attempt」；调度校验只允许 queued 没有 attempt。

修复保留原始 run 状态，显式启用 cancelled 的只读 frontier 检查；
仅真实 cancelled run 的 cancelled、attemptCount=0、无历史 attempt 步骤允许无 latestAttemptId。
原有 step 定义、inputHash、inputRefs、当前 attempt 归属检查保持；取消后的检查永不生成执行 children。
这不改变模型预算、超时、分析规则、证据或来源隔离。

验证：先新增纯回归复现同一异常，再修复后通过 reconciliation-flow 12 项、keyword-flow 10 项；
keyword-public 3 项含真实 PostgreSQL service 取消/读取回归、重复取消、跨组织拒绝、无网络副作用。
public fixture 模型名称改为已知 tokenizer 的 gpt-5.6（仍为注入的假客户端）；
批次打包变化后以初始关键词成员总数替代固定批次数断言。TypeScript 检查通过。
定向 ESLint 的生产文件通过，两份既有测试文件仍有 26 处原有 explicit-any 报错，本次新增代码不引入 any。

经授权，仅对该隔离 schema 的上述关键词任务和总览任务
`31e536b0-2848-46b1-afbc-f5690a20b669` 调用正常 service.cancel 收尾，随后服务读取成功。
记录：`.superpowers/sdd/market-live-acceptance-20260917/cancel-repair.json`。
关键词保留事实且审计为 1 failed/0 pending；总览 cancelled 且无模型审计。
没有模型或供应商请求，没有操作其它任务或正式任务。

总览限流只读证据：同目录 `governor-read-only.json`。
正式 governor 当前策略为 30 次/60 秒；该 run 的 30 条 physical attempt 均在 02:31:46–52 UTC，
02:31:55 和 02:32:24 的滚动计数均为 30，后续失败及延后重试没有新增 physical attempt。
结合 governor 在 HTTP dispatch 前拒绝的代码，归因为本地滚动限流，不能写成已确认供应商 HTTP 429。
