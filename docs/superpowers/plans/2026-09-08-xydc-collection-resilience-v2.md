# XYDC-ANNUAL-V2：采集恢复与真实进度实施计划

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan. Steps use checkbox syntax for tracking.

**Goal:** 修复已观察到的限流、批次失败后重复采集与无进度反馈；不扩展月度展示。

**Architecture:** 复用现有 MCP SDK、跨进程锁、订单契约和同步任务租约。单次订单批次使用惰性会话和凭证级协调；子体校验成功即保存独立检查点。可选的任务绑定进度记录由可信租约上下文产生，经现有鉴权接口只读提供，前端只显示实际状态。

**Tech Stack:** Node 24 / TypeScript / MCP SDK / Zod / PostgreSQL job authority / React / node:test / local HTTP fixtures / Playwright.

## Global constraints

- Scope version XYDC-ANNUAL-V2. 本计划只实施 B1/B2，A1/A2由年度计划负责。
- K1 保留固定近12个完整 UTC 月、原始0未披露语义、父子身份校验、现有年度汇总和既有月度趋势。
- D1 不新增月度悬浮、月度选择、月度投影、月度图交互。D2 不做饼图/环形图。
- X1 不改正式服务、共享数据、并行工作树；不重启/激活、不主分支合并、不GitHub推送、不真实Provider调用。测试只用临时目录/本地假端点/隔离测试数据库。
- 工作树固定 C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/fix-voc-import-status-20260907，分支 codex/feat-xydc-parent-orders-12m-20260908。保留全部用户文件和 test-results；一次一个源代码实现者。
- 不引入新的全局任务调度协议、数据库迁移或Provider依赖。修改共享入口前与 OpenSpec 窗口核对，禁止按旧撤销任务继续实现。

## 已核实的接入事实

- 当前 callXydcTool 每业务调用创建连接；实际请求包括 initialize、通知、GET流和 tools/call，单看 tools/call 的2秒间隔不能证明HTTP节流。
- SDK streamableHttp 的 fetch.signal 使用内部控制器覆盖 requestInit.signal；超时/取消必须实际关闭 transport。成功后不能通过 abort 清理计时器，否则可能产生多余取消通知。
- provider-network-bootstrap 只配置 DNS；detachedProviderEnvironment 合并传入env，不做西柚 fetch 包装。
- 订单 collector 当前只在批次最后写family缓存，长 Retry-After 被30秒上界丢弃；需保存完整子体并尊重供应商等待。
- canonical traffic 可提前结束 analysis_runs，而 sync_jobs 仍 running。取消判断不能使用任意 run 终态；以固定 job/lease generation/owner 的有效租约为主体，关联 run 的显式 cancelled 为否决条件。
- run-asin-sync-job 的普通步骤使用spawnSync。仅西柚步骤改为直接Node异步可等待子进程，并提供父链死亡检测（例如自有IPC断开即abort）；避免Windows npm/shell孙进程在父runner结束后仍通过短期有效DB租约继续发请求。进度仍由西柚子进程自行校验租约并写旁路文件，该文件不是任务权威，不靠stdout当作授权证据。

### Task 1: B1 凭证级真实请求协调、惰性会话与逐子体检查点

**Scope inside task:** XYDC-ANNUAL-V2，允许 B1 及供 B2 消费的可选事实事件回调。K1 保留12个月既有数据和展示。禁止 D1 月度新增交互/投影、D2饼图，以及 X1 正式服务/共享数据/主分支/远端/真实Provider改动。不实现进度UI或通用任务重构。

**Files owned:** scripts/lib/xydc-mcp-client.ts；可新增 scripts/lib/xydc-request-coordination.ts、scripts/lib/xydc-mcp-session.ts、必要时xydc-provider-error.ts（按职责拆分，不循环依赖）；scripts/lib/xydc-order-sync.ts；scripts/lib/xydc-order-cache.ts 或新 xydc-order-checkpoint.ts；相关 tests/scripts/xydc-mcp-client.test.ts、xydc-order-sync.test.ts 和新 xydc-request-coordination.test.ts、xydc-order-checkpoint.test.ts、tests/helpers/xydc-*.mjs/ts。本任务不改 page/worker/runner/共享锁实现/计划/进度台账。若必须调整已有函数接口，先查调用点并保留现有调用兼容。

- [x] **RED：先复现目前缺陷。** 新增本地 HTTP MCP fixture，记录全部方法/时间戳/连接和业务次数。测试多个业务调用应只initialize一次；任意HTTP相邻发送至少2000ms；现有实现应失败。另测一个成功子体后中断，重开只请求未完成子体；当前只末尾写缓存应失败。运行并记录精确失败断言，不以编译错误作为RED。
- [x] **协调契约。** 真实调用要求绝对服务器端 XYDC_COORDINATION_ROOT。键为规范化endpoint与trim后token的SHA256，不存原token、session ID或Provider响应。仅同主机/同目录协调；不共享其他runtimeRoot。缺失/非法目录报 NOT_CONFIGURED，无法安全读写/损坏状态报安全 RPC_ERROR，均不发请求。测试注入 callTool 维持离线兼容，不要求生产目录。
- [x] **会话边界。** 导出 withXydcSession(token, run, options) 一类有界scope API；run接收只允许3个现有工具的 callTool。scope先获取既有 acquireInterprocessLock 的凭证独占批次锁，再调用run；连接直到第一次真实调用才创建。callXydcTool 保留旧签名，真实单调用通过同scope；collector一次批次只用一个scope，不嵌套同锁。没有待采集项不创建scope、更不连网。不同凭证不共享SDK对象/headers/在途请求。
- [x] **发送闸门与超时。** 每个实际HTTP发出前检查 nextAllowedAt/cooldownUntil、剩余预算和signal，再原子持久化nextAllowedAt；initialize/通知/GET/tools POST全覆盖。HTTP起始间距2000ms。订单阶段总预算300000ms包括等待锁、排队、冷却、连接、请求；旧单次调用15s包括排队。tools POST真正发出后15s内完成，不能把排队误算成工具超时；initialize/通知亦有界；GET仅响应头等待有界，不每15s打断合法长流。成功清除定时器/监听器，不触发abort或取消通知。超时/取消关闭底层transport/socket并清理所有资源，禁SDK隐式重试/重连/结果未知重放。
- [x] **429规则。** 任意工具/HTTP429均持久化凭证冷却；支持合法Retry-After秒数与HTTP-date，不能把>30s当作缺失或截短。没有有效指示时当前批次第一次退避30s，第二次60s；显式不可表示超长等待停止自动请求，不偷偷改为短等待。每子体最多2次业务尝试，仅明确429可自动重试；二次429停止本批次后续子体。认证/额度不足停止批次；404/坏结构为该子体失败；超时/未知结果不自动重放。等待超预算保留已有结果并结束，不提前请求。冷却随scope结束、错误及进程重启仍有效。
- [x] **检查点与缓存。** 完整且通过身份/12月校验的子体成功后立即原子保存，身份含country/parent/sorted完整child集合/window/childASIN。保留真实响应时间，可注入wall-clock供测试；缓存复用保留旧时间。只复用<=24h、不在未来、完整匹配的条目。获取凭证锁后再读缓存/检查点，避免排队任务重新收费。force绕过旧缓存读取，但新成功检查点立即保存；失败刷新不覆盖以前完整的family展示快照。新成功检查点独立于旧family保留，后续普通补采复用新成功项。写入采用现有atomic/lock模式，旧时间不能覆盖较新条目；不同凭证不承诺全局付费去重，但不得损坏缓存或倒退完整数据。
- [x] **事实事件接口。** 为 input 新增可选 env/onProgress/beforeRequest，保留旧调用。beforeRequest 是可选异步权限栅栏，沿会话传到真实HTTP闸门，在实际发送前（排队后）执行；失败不发请求，不做隐式重试。事件是当前固定窗口、country+ASIN去重队列的实际状态：queued/collecting/rate-wait/completed/partial/failed/cancelled；child事实包含ASIN、country、ready/cached/failed/pending以及安全reason；retryAt仅真实冷却时间。ready只计实际12个月返回齐全（含供应商0未披露），失败不计就绪；不能按流逝时间推算百分比。回调不携带token/raw响应/其他项目数据。进度持久化失败不能重放业务请求。
- [x] **GREEN验证矩阵。** 真HTTP测试同时覆盖同凭证两个子进程不重叠且冷却跨进程保留、不同凭证隔离、失败initialize释放、取消在锁/等待/连接/业务各阶段关闭、成功不晚发cancel、Retry-After120s/HTTPdate/缺失/超预算、工具业务不隐式重放。用可注入时钟快速单测长等待，但至少一个真实时间间距测试不缩短生产默认。缓存测试覆盖成功后崩溃恢复、force部分失败+新检查点、旧写不覆盖新、国家/parent/child集合/window改变不复用、不同国家相同ASIN不串、全缓存0 HTTP。断言真实请求数，不只mock函数次数。
- [x] 运行 node --import tsx --conditions=react-server --test tests/scripts/xydc-order-summary.test.ts tests/scripts/xydc-order-sync.test.ts tests/scripts/xydc-mcp-client.test.ts tests/scripts/xydc-variant-sync.test.ts tests/agent/xydc-order-runtime.test.ts 及新测试；变更文件ESLint/diff-check。必要类型检查对比既有341诊断基线，不掩盖原债务。
- [x] 仅提交本任务代码/测试，写明新增API、RED/GREEN命令结果、已知限制到独立report；等待双重任务审查，不启动下一任务。

### Task 2: B2 可信任务进度、取消栅栏与只读前端等待提示

**Scope inside task:** XYDC-ANNUAL-V2，允许 B2 和 B1 最小运行入口接线。K1 保留12个月数据/汇总/原趋势；A1/A2已完成代码必须保留。禁止 D1 月度新增功能、D2饼图和 X1 正式服务/共享数据/主分支/远端/真实Provider改动。不新增数据库迁移、不改通用pipeline终态语义、不改VOC进度。

**Prerequisite:** Task1任务审查通过；读取它的API/report。[OpenSpec] 同步流水线稳定化 指令窗口已确认无正在写入的冲突，可继续；这不是实现验收或发布许可。保留其五项边界：可信lease身份及abort链、runner其他Provider/immutable发布合同、现有GET鉴权完整ASIN校验、page过期响应拦截、不用正式旧文件覆盖当前K1增量。

**Files owned:** 新 shared/xydc-order-progress.ts；新 scripts/lib/xydc-order-job-progress.ts 或按DB租约/文件存储职责小拆分；scripts/build-xydc-variant-data.ts；server/services/sync-job-worker-handler.ts 中仅detached env；scripts/run-asin-sync-job.mjs 中仅可选西柚上下文/取消转发；app/lib/runtime-analysis-data.ts、runtime-analysis-data-server.ts 与 app/api/runtime-analysis-data/route.ts 的实际现有路由；新 app/lib/use-xydc-order-progress.ts 或纯owner模块、app/xydc-order-progress.tsx；app/page.tsx 最小hook/props接线；app/xydc-variant-section.tsx 与相关CSS最小进度区域；各对应定点测试、新 scripts progress HTTP/临时PGfixture测试；.env.example/README的西柚相关配置段。先 rg核实路由文件准确名称，不能为猜测路径新建第二套接口。

- [x] **RED：进度隔离测试先行。** 同一授权project+currentRunId+job固定代次允许读取；跨组织/项目、旧run、旧lease generation、国家/子体/window不匹配拒绝，不返回全局计数。UI测试验证2/3真实就绪而不是完成100%，隐藏/切换项目后旧响应不能落入新项目。现有无进度实现应在行为断言上失败。
- [x] **可信入口。** launcher显式传organization/project/run/jobId/workerId/leaseGeneration给西柚子进程，使用租约里固定值，不让旧子进程查询当前generation后冒充新任务。runner仅透传可信运行上下文，不把诊断mirror当权威。仅西柚步骤使用可等待的直接Node异步spawn，调用点await其结果；保留其他Provider和现有同步注入测试兼容。建立自有IPC或等价父链死亡检测，父runner被直接杀死也立即取消西柚，不依赖DB租约到期；不可仅在父finally发SIGTERM。子进程自身signal与每1秒的只读DB栅栏贯穿整个采集等待/请求；SIGINT/SIGTERM/父链断开同样中止。每次请求/进度写前检查固定租约仍running、未过期且owner/generation相同，关联run若explicit cancelled即中止；analysis run的其他终态不能误杀仍有效sync job。连接/查询有界，校验失败fail closed不再发付费请求。无可信job上下文的单独CLI仍可生成诊断结果，但不能发布项目任务进度。
- [x] **进度不是权限来源。** 严格版本1记录包含org/project/run/jobId/leaseGeneration、country、固定window、已验证family父子集合与实际child事实、updatedAt/retryAt/safeReason。写入runtimeRoot/xydc-order-progress/v1下按job+generation隔离文件，原子写并校验固定身份，旧代次不能覆盖新代次。文件最多64KiB；无原凭证/Providerbody/数据库URL。心跳15s，超过45s无新证据显示interrupted，不保持假活跃。终态保留最多24h，清理只处理验证过的本目录终态文件，不能删除active/未知文件。不是依赖清理保证权限。
- [x] **鉴权读取。** 复用现有GET/v1/projects校验结果，必须从服务端确认的organizationId/projectId/currentRunId取scope。由实际job/lease状态再验证sidecar，父子范围只能来自该授权项目的有效family。读取文件不可接受请求端任意路径/job/组织字段。无有效记录兼容旧snapshot并返回null，旧run/代次直接不采用。读时用相同run/job/generation的DB状态覆盖展示取消/失败/中断，不要求失租子进程越权补写终态：关联run cancelled优先为cancelled，job failed为failed，无有效活动租约或过期心跳为interrupted；合法completed/partial sidecar在DB正常complete清空owner/expiry后仍允许读取。generation变化一律拒绝旧记录，不能放松失租写权限。GET只读，不重新enqueue/采集。进度只投影当前授权集合，不泄漏其他family/项目全局计数。
- [x] **客户端单一poll owner。** 整个项目一个5秒轮询；仅可见页面且实际sync job活动/有效非终态订单进度时运行。采用AbortController+scope epoch，隐藏/切换org/project/run/asins/logout/unmount停止并忽略迟到响应；无重复并发poll。已有refreshRuntimeAnalysisData继续负责一致更新目录/订单快照，终态再刷新一次后停止。需要兼容readRuntimeAnalysisData旧3参数调用，可选signal扩展，不侵入traffic/VOC轮询。启动时job活跃但还无sidecar可显示“等待订单采集”；单纯浏览历史项目不能启动任务。
- [x] **展示。** 西柚区域一个紧凑进度条和文字：已就绪2/7（缓存复用1），当前采集/限流等待/部分完成/完成/失败/已取消/已中断。百分比仅ready/total；部分失败不可100%成功。真实retryAt可以倒计时，到时只显示等待下一次实际状态，不自行采集。完整12月中的未披露0仍算数据响应就绪，和“有披露订单”区分。没有任务进度时隐藏整条，不把旧缓存看作活动任务；不改年度卡片/已存在月度图。
- [x] **生产运行接线。** 用已有runtimeRoots和独立XYDC_COORDINATION_ROOT配置，同一主机需同凭证任务使用同一个显式协调目录但数据与其他runtimeRoot仍隔离。.env.example只放占位路径/说明，不引入密钥。不默认写正式目录，不修改用户实际.env或服务管理配置；缺少配置给出可诊断安全错误。CLI关闭时清理租约查询连接/定时器/sockets，await需要等待的写入；不能把optional西柚失败升级为其他同步阶段失败。
- [x] **GREEN矩阵。** 隔离真实PG job/run fixtures验证：有效lease继续、analysis run succeeded/partial/failed且job运行继续、run cancelled/job failed/owner变更/lease过期停止（现有sync job没有cancelled状态，不新增该状态）；旧代次旁路文件不展示。真实子进程SIGTERM/等待429期间取消后无更多HTTP；另保持DB租约有效，仅中止父runner，断言西柚停止且原父runner进程链无残留。鉴权GET无session/跨项目/旧run/超大损坏file/过期heartbeat/终态owner已清空/取消后未补写sidecar等案例；UI假计时器+延迟fetch验证5s/visible/epoch/一次终态refresh，无100%假进度。全部测试不接正式数据库或真实Provider。
- [x] 定点Node前后端分开条件运行，变更ESLint/diff-check、isolated npm run build、类型diagnostic基线对照；现有A1/A2和K1 UI回归必须绿。报告真实失败/重试，不能只报最终一次绿色。
- [x] 仅提交本任务源代码/测试/配置说明，写独立report；任务审查通过后由root进行V2整分支终审和已缓存真实ASIN预览验证。测试通过不等于正式发布，正式系统保持不变。

## Final verification and delivery (coordinator only)

以下检查由root在两项任务审查通过后执行，不属于B2实现者的提交或自我验收权限。B2实现者只报告自己的测试与边界，不标记整体任务Approved或触碰正式环境。

- [x] 回归范围：B新增测试 + 当前订单server67基线 + 年度UI；不混用react-server与浏览器React条件。
- [x] V2整体代码范围从 ef6867848e4e56c4450bf20946ca9f88973b43ca 审查；检查没有新的月度交互/投影和没有越界生成数据。
- [x] 使用 test-results/xydc-current-asins-20260908 已有快照验收，绝不自动collect：LEPOWER5900+、OYEARS3750+、SUNMORY59450+，固定2025-09..2026-08。
- [x] 完整记录模拟测试和真实Provider未复测边界、既有全仓类型诊断；验证正式状态和共享输入hash未改变后再交付。
