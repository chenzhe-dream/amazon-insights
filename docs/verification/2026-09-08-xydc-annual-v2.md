# XYDC-ANNUAL-V2 验证记录（进行中）

## 范围与状态

- 整体基线：`ef6867848e4e56c4450bf20946ca9f88973b43ca`。工作树 `fix-voc-import-status-20260907`，分支 `codex/feat-xydc-parent-orders-12m-20260908`。
- A1/A2、B1、B2均已完成任务复审；整分支审查与修正后的最终组合验证进行中。本文不是整体完成、正式发布或真实 Provider 复测声明。
- 保留原有固定近12个完整UTC月、年度汇总、现有月度图及无障碍数据。没有新增月度悬浮、月份选择、月度投影或饼图。
- 不改正式服务、共享数据或并行工作树；没有主分支合并、远端推送、正式重启或新的真实西柚查询。

## A1/A2 年度悬浮与年度表折叠

- 实施基线 `4e21b5a252b2c1fcc6aee32ba7237d2e79570896`。
- 首次实施 `30296a401cc80157a5bcc267726cf2caf0577662`；独立审查发现两项 Important：移除后立即重加身份残留旧触发器，浮层宽度错误包含滚动条占位。
- 修正提交 `8cab00e6d57090f6c377317fd8bfcc7f5d6fe7e2`。两个缺陷先新增稳定失败用例再修正；独立复审 Spec compliant / Approved，无剩余问题。
- Root 重跑 `node --import tsx --test tests/agent/xydc-order-section.test.tsx`：**14/14**，失败/跳过/取消均0，16217.3993ms。
- 实施者重跑年度汇总11/11，变更文件ESLint及diff检查通过。最终组合构建、类型对比留到B任务完成。
- Root 在首次A提交时以只读TypeScript CompilerHost对比整体基线：两端均341诊断，规范化文件/错误码/完整消息指纹集合完全相同。这不代表全仓类型检查通过；修正及B完成后仍需最终重跑。

## 已有真实数据的只读界面复核

仅使用 `test-results/xydc-current-asins-20260908/preview-props.json` 的已采集快照；未执行采集入口。

| 输入ASIN | 父体 | 2025-09至2026-08订单汇总 |
| --- | --- | --- |
| B07R56PTMS | B0B9S3D13G | 5,900+ |
| B0F18D9B5V | B0D9W22TTY | 3,750+ |
| B0CDW797MM | B0HCC8ZN3W | 59,450+ |

- Root 隔离预览 `http://127.0.0.1:31911/`，修正后预览子进程PID75736。仅重建自己创建的预览，不涉及31900/31901正式服务。
- 验证LEPOWER年度表首次折叠；展开后Sand Black浮层保持完整ASIN、4,000+、67.80%、缺失/未披露0/0。
- 实际390px窗口中：可用宽375，高720；浮层右边367、下边714.03125，仍是对话框DOM后代。修正前右边382超出可用宽的问题已消失。
- Root 已查看截图 `test-results/xydc-v2-real-annual-mobile-fixed.png`。独立无头浏览器会话已关闭，未控制用户Chrome。
- 工具误用记录：首次旧预览的按钮在可见范围外，CLI点击未打开对话框，滚动到可见范围后正常；一次JS命令引号解析失败，改用CLI文档支持的base64输入后得到测量值。均未作为产品缺陷或通过证据。
- 引号失败的cmd包装调用还意外产生了根目录零字节文件 `({text`；核实创建时间、长度及此前状态后，仅删除该本轮工具空文件，其他未跟踪数据保留。

## B任务前置基线与集成边界

- 已有订单服务基线67/67、原年度UI基线7/7。
- Root runtime-analysis-data、sync-job-worker-handler-lifecycle、sync-job-detached-provider：33/33，4038.5151ms。
- Root `node --test tests/scripts/asin-sync-job-postconditions.test.mjs`：22/22，153.1641ms。
- OpenSpec并行任务已确认无活动文件冲突；保持可信租约与取消链、其他Provider/不可变发布合同、GET鉴权完整ASIN检查、页面过期响应屏障及K1增量。该协调不是实现验收或发布许可。
- B1实施基线 `7f7aba59d254c12836fb44b80326c2e0fad763dd`；只使用临时缓存、本地HTTP假端点和假凭证。B1及B2完成后补充本记录并做整体审查。

## B1 采集恢复：首次实施及审查修正

- 提交 `155865e4a16ec1edb0f9b4b846581b3706d2e2fb`，13个限定源代码/测试文件；未修改UI、runner、worker或其他Provider。
- Root锁定提交后重跑既有订单/客户端/变体/runtime与新增协调/检查点测试：**96/96**，失败/跳过/取消0，91866.2699ms。实际HTTP2秒节流、跨进程冷却、等待/连接/业务取消、成功无晚发cancel、GET头15秒与已建立SSE存活、真实进程退出后补缺项均覆盖。
- 新增业务SSE测试曾发现API报告TIMEOUT但具体ServerResponse仍开放，不能以此前93项绿色掩盖。强引用请求控制器假设没有修复；最终在关闭SDK重连后取消持有的具体响应读取器，原15秒+1秒关闭watchdog通过。未证明Node/SDK缺陷，不将弱引用假设写成根因。
- 本轮还修正慢fsync造成实际请求扎堆、冷却文件乱序覆盖、GET计时器误清理、成功请求误abort、未来缓存阻止修复、force中断后忽略新检查点、检查点写入故障后继续付费调用及挂起的权限回调不受预算约束。逐项RED/失败假设/GREEN记录在实施report。
- Root完整TypeScript基线对照：155865e与ef68678均341诊断，规范化文件/错误码/完整消息指纹集合完全相同，新增0/移除0。不是全仓类型检查绿色。
- 独立审查使用固定范围7f7aba5..155865e的104989字节包，结论 Spec issues / Needs fixes。审查者用三个临时本地探针分别复现：429冷却在异步权限检查/持久化期间到达后仍提前发送；HTTP202导致业务RPC结果的15秒截止被清除；永不返回的onProgress阻止取消/预算收尾。Root核实源代码后交回同一实现者逐项RED/GREEN修复，不能用上述96项通过代替这些缺陷的修正。
- 进度回调的取消边界：采集器必须约束自身等待和收尾，取消后不再发起请求或后续回调；任意外部JavaScript回调自身的副作用不能被强制停止。可提供兼容的signal/context让B2实际写入者同时落实租约授权和生命周期检查。B2仍待B1复审通过。
- 修正阶段中间一次完整回归112/113：原有100ms挂起权限回调用例在123ms返回RPC_ERROR而非TIMEOUT。随后真实Client.connect定点探针把SDK自身截止设为5ms、scope仍1000ms，稳定捕获McpError -32001先触发且映射为RPC_ERROR；这是已复现的截止竞争，不以扩大断言窗口处理。最终修正及稳定提交的复跑结果见下文。
- 修正提交 `d7b586195b1e8afeaa142a16409669573dfa5652`：冷却在异步边界后重新检查；权限栅栏位于最后一次持久化之后；202保留RPC结果截止；统一phase限制观察者及缓存路径的等待；SDK的RequestTimeout按配置保留TIMEOUT/BUDGET_EXHAUSTED。
- 实施者稳定代码114/114（107.122s）；Root锁定d7b5861独立重跑同一七文件组合：**114/114**，失败/取消/跳过0，108231.3871ms。该版本完整类型诊断341，与ef68678的文件/错误码/完整消息指纹集合完全相同（新增0/移除0）。
- 独立增量复审范围155865e..d7b5861（42714字节）：**Spec compliant / Approved**，三项原Important及修正后的权限/SDK截止边界均通过，无新Critical/Important/Minor。B1任务完成；B2和整分支验收仍分开进行。

## B2 进度接线：提交前检查

- B2实施者仍是唯一源代码写入者；Root只修改协调文档、执行只读检查和自己的隔离预览。任务审查和整分支审查尚未完成。
- Root检查实际page共享setter，发现并推动修正三项接线问题：scope遗漏market且A→B→A旧响应可能恢复；新job首次无sidecar时没有发现查询；独立发现查询不受可见性取消且可能与5秒poll重叠。现在使用每次已提交scope的唯一token，在实际catalog/snapshot写入前检查，并把发现和poll归入同一owner。并未宣称其他手动/Provider刷新全局合并。
- 实施者提交前自审另复现：终态写入等待DB授权时，心跳旧状态可能排到终态之后。已有确定性RED，修正为publisher先更新latest再入同一队列；最终测试与提交证据待报告。
- 修正后再次source冻结时，Root完整TypeScript诊断仍341，与ef68678的规范化文件/错误码/完整消息hash多重集合精确一致（新增0/移除0）；page ESLint仍10错误/7警告，17条规范化规则/严重度/消息/实际报错语句多重集合也精确一致。这不是全仓类型/lint绿色。
- Root只停止已核实属于自己的旧预览PID75736并重建31911，新PID10080、session79886。该预览使用esbuild内存bundle和原preview-props.json，不读取dist、不调用采集入口、不更改缓存文件。
- 当前B2源码下，三个卡片年度汇总5900+/3750+/59450+、Sand Black年度浮层4000+/67.80%、年度表初始aria-expanded=false保持；无任务的快照页progress元素为0。390px截图浮层完整可见，原月度图仍保留。
- Root已查看 `test-results/xydc-v2-final-annual-desktop.png`、`test-results/xydc-v2-final-collapsed-dialog.png`、`test-results/xydc-v2-final-annual-mobile.png`。独立无头浏览器会话已关闭，用户Chrome未控制。两条辅助DOM探针误用了原生dialog/aria-label选择器，未采到目标；截图及实际role=dialog复查正常，空探针结果不作为产品缺陷或几何通过证据。

## B2首次提交、任务审查与组合复测失败

- B2首次提交 `2e6036674bce19d884c7919933da1211a27b4367`，24个限定源代码/测试/配置说明文件，1164增/24删。实施者报告最终server168/168（108.488s）、UI26/26、runner22/22、隔离build通过。报告保留此前缺失模块/fixture选择/启动等待失败与心跳race的确定性RED，不把它们抹掉。
- 独立任务审查范围77d92b2..2e60366，107653字节：Spec compliant / Approved，无Critical/Important。一个Minor：真实runner吞掉子stderr，安全的缺少协调目录原因变成笼统optional停止告警，待最小allowlist诊断修正。
- Root锁定2e60366并行运行server与UI：UI **26/26**（22944.5358ms）、runner **22/22**（462.1756ms）通过；server **167/168**，不是通过。失败项为原B1 `late 120s cooldown during authority wins before actual dispatch`：2146.2366ms，在测试第30行的 `acquireXydcCoordination` 初始化抛RPC_ERROR，尚未进入cooldown断言。
- 所有测试断言结束后该文件进程仍持有HTTP fixture；只读PID检查确认只剩owned test子进程75600、父root测试30624。Root只停止已核实的75600以使结果收尾，最终总时长298515.0278ms。未操作正式服务或其他测试进程。
- 已确认测试的fixture在acquire前创建，try/finally却从acquire后开始，因此初始化失败绕过清理。Windows底层2秒进程身份查询在并行启动时超时是待验证解释，不当作已证明根因；生产协调器此处仍fail closed。修正要求确定性覆盖失败也清理，不改变生产锁、不放宽阈值或重试到绿色。
- 同一B2写入者正在处理上述测试清理与allowlist诊断小批次；任务审查通过不代表整分支已可交付。最终重跑将分开服务端和UI，保留本次失败证据。
- Root本轮隔离build退出0（7.6447s），源码与dist均为 `d5ed3a28a0b24419765aedd3c464ac9608a5ea12363fb3fce2f9d3c3e1dbf171`；只在唯一OS Temp目录设置假DB与空Provider配置，不启服务。修正后的最终build仍需补。
- 正式目标只读HEAD仍deab0aa、31900health仍ok/artifact043a0f07；共享项目和三个variant输入SHA256与此前基线精确相同。

## B2修正任务门

- 修正提交 `e52d9b5b37a4162ae6d8f122314586b8b63a49cb`，4个限定文件。测试fixture创建后立即注册test.after，原cooldown断言保留；独立子进程注入mkdir EIO证明RPC_ERROR仍可见、server/root不泄漏。生产锁、时限、重试均未改，原Windows初始化错误的底层原因仍未证明。
- runner只接收完整的128字节以内ASCII行，限5个已知安全reason；超长、未知、前后缀污染、不完整行和任意Provider文本不透传。真实缺配置及恶意输出/分块CRLF用例均先RED再GREEN；optional失败和IPC合同保持。
- 实施者单独协调文件30/30（108.666s，自然退出）、runner24/24、变更lint/diff通过。Root最终matrix改为server文件串行、之后UI，原失败仍记录而不是被重跑抹除。
- 独立增量复审2e60366..e52d9b5（23160字节）：Spec compliant / Approved，无Critical/Important/新增Minor，原诊断Minor已解决。A、B1、B2任务门均完成；最终V2 gate仍独立。
- 最终source-only指纹为 `2d45a66d6e5403b8d84cc9a63367778c07f56f89ae96edc42f518c5a7be6fedb`。此前dist对应旧源，最终build不可借用其通过结论。
