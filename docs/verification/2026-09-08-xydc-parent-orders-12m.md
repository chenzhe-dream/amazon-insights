# 西柚12个月订单份额开发验证

## 开发前记录

- 用户要求先保存现有版本；开发前检查点为 `c7c8875`，实施计划为 `1405329`。
- 只在 `fix-voc-import-status-20260907` 工作树、`codex/feat-xydc-parent-orders-12m-20260908` 分支开发。
- 西柚前端18项、客户端/同步/runtime43项，合计61项定向基线通过。
- 首次混合React条件导致的四项Windows `spawn ENAMETOOLONG`，在前端使用普通React、后端使用react-server的正常分开运行方式下消失；没有改测试来跳过断言。
- 开发前全仓命令 `node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false` 非全绿。最初313是被工具截断日志中的可见诊断数，不是全量基线（原日志50491tokens，截去5491tokens）；不得将它与完整日志计数直接比较。Task2后完整日志341条；只读虚拟基线重建也为341，逐条诊断指纹集合相同，无新增/减少。`app/page.tsx`已有8条，涉及URLSearchParams、PriceStrategy和alexa-voc-normalization类型；不得声称全仓类型检查通过。
- 只读记录正式工作树原有15个生成文件的SHA256，正式HEAD为`deab0aa`。本轮不会修改正式服务、共享数据或其他并行开发工作树。

## 验证状态

年度合同、采集/缓存、授权读取和页面已完成分层独立审查；控制者最终定向测试、构建和截图检查通过。全分支独立终审为Ready to merge Yes（技术批准），无确认的Critical/Important；正式服务未切换，真实采集未验收。

### Task 1：年度合同与统计

- 实现提交：`1724d9375ae7177c85b23c9b04335e14b7a29c21`，仅新增合同、纯统计函数与对应测试三个文件。
- 实现者记录初始缺模块 RED、缺失子体行 RED10/11，修复后 GREEN11/11；旧变体同步回归26/26。
- 控制者在该提交新执行 `node node_modules/tsx/dist/cli.mjs --test tests/scripts/xydc-order-summary.test.ts`：11通过，0失败/跳过/取消。
- 实现者按项目ES2017目标执行三文件TypeScript与ESLint检查均通过。
- 独立审查：Spec compliant / Task quality Approved，无Critical/Important；Minor为无名称的无效合同测试循环诊断可改进，已交最终审查汇总。跨任务采集、runtime和UI由后续任务及最终审查验证。
- 额外核心非阻断入口基线：`node --test --test-name-pattern='catalog phase invokes XiYou' tests/scripts/asin-sync-job-postconditions.test.mjs`，1/1通过。

### Task 2 开发过程记录

- 控制者在实现者新增边界测试的RED周期执行六文件定向组合，69/70通过；唯一失败为强制刷新返回部分月份时，旧完整快照的cacheState仍为fresh。
- 实现者确认该RED并报告已将PARTIAL_DATA纳入失败强刷回退；待锁定提交后重新执行组合测试，不以开发中结果作为完成证据。
- 开发中只读复查正式工作树15个生成文件SHA256，均与开发前一致。
- 实现提交`f2f77e2`后，控制者新运行六文件组合70/70通过，0失败/取消/跳过。但独立审查及补测未结束，测试全绿不等于本层可交付。
- 控制者真实临时文件缓存+模拟网络补测确认两项：同窗口过期48小时的完整缓存请求数为0，旧值100被重新打上当前快照时间（应请求并取得200）；US/UK同ASIN混合输入只请求US一次，两个站点均写入100（UK模拟应返回200）。补测脚本`.superpowers/sdd/xydc-orders-cache-probe.ts`，无真实Provider调用。等待完整审查结果后合并修复。
- 修复提交`b211b21`后，控制者重新运行六文件组合77/77通过；三个实测补测均符合预期：过期缓存请求1次并取得200、US/UK分开请求并返回100/200、合并父体返回1份完整集合订单快照。runtime同时检查每个子体时间，旧变体payload保留不变。
- 独立二次审查：Spec compliant / Task quality Approved，无遗留Critical/Important/Minor。Task2完成；Task3 UI仍待实施和验证。
- 核心同步postconditions完整文件22/22通过。
- 基线核对脚本`.superpowers/sdd/xydc-ts-baseline.mjs`以TypeScript CompilerHost在内存中覆盖Git检查点`c7c8875`的变更源文件，并排除后加源文件；不修改工作树、不创建新工作树、不写编译产物。分别以`c7c8875`和`current`执行：341/341，按文件+错误码+完整消息哈希比较，新增0、消失0。完整CLI当前检查仍非零退出，如实保留原有技术债。

### Task 3 开发过程记录

- 初始 RED：旧组件仍输出“变体结构与商品页表现”，新年度卡片断言失败（0/1），实现者记录后开始替换页面。
- 审查关注：真实数值柱高、缺失月份、SSR hydration 一致性、测试固定时钟、项目/ASIN或runtime数据变化后的弹窗隔离。最终结果待锁定提交后补充。
- 界面测试使用独立 headless 浏览器和离线 fixture，不接管用户 Chrome。
- 控制者首次肉眼检查了 `test-results/xydc-orders-desktop.png`、`xydc-orders-mobile.png`、`xydc-orders-dialog.png`：桌面两列、390px手机单列、选中父体弹窗可见；5,900+样本和67.80%/19.49%/11.02%预览正确。图片与ASIN均为离线测试示例，不是实抓或正式服务验收。
- 页面收尾期间再次读取正式工作树：HEAD仍为`deab0aae8f7d5a04fd7787a0292f4285fa7cabae`，15/15个既有生成文件SHA256与开发前一致，差异0。
- 实现提交`5309104`，仅七个预定页面、样式与测试文件；页面只增加`orderFamilies`传参。
- 独立Task3审查为Needs fixes（无Critical、六项Important）：待采集时隐藏已知变体字段；没有命中ASIN；丢失子体信息状态/变体缓存状态；柱高4%和4px下限扭曲极低值；月度图缺少可访问文本等价内容；父体移出后再加入会自动重开详情。控制者委托单个修复者批量修正，修复完成与二次审查前不交付。
- 三项Minor留最终审查判断：10–11px字体、超过8子体颜色重复、SSR/客户端分别读时钟可能跨UTC月边界；不在修复中自行做广泛重构。
- 修正提交`4fef34e`后，控制者新跑UI13/13（约7233ms），类型341逐条指纹仍与检查点一致。独立复核确认五项修复，但详情选择使用model对象引用：真实页面每次render都会构造新的products数组，导致同父体普通刷新也关闭弹窗。该生命周期问题继续修复，不能用13/13掩盖此缺口；此提交未作为最终构建或交付结论。

## 控制者阶段验证（代码5309104；当时审查未结束）

以下均在隔离补丁工作树执行，使用离线fixture和临时缓存。

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/agent/xydc-variant-section.test.tsx tests/agent/xydc-order-section.test.tsx
node node_modules/tsx/dist/cli.mjs --conditions=react-server --test tests/scripts/xydc-order-summary.test.ts tests/scripts/xydc-order-sync.test.ts tests/scripts/xydc-mcp-client.test.ts tests/scripts/xydc-variant-sync.test.ts tests/agent/xydc-order-runtime.test.ts tests/agent/runtime-analysis-data.test.ts
node scripts/run-stable-build.mjs
node .superpowers/sdd/xydc-ts-baseline.mjs current
```

- UI：11/11，0失败/取消/跳过；约9721ms。含真实SSR/hydrateRoot、固定时钟、独立浏览器、屏宽几何、图表数据比例、缺月、Tab/Escape/焦点返回及父体范围变化。
- 数据与服务六文件：77/77，0失败/取消/跳过；约2594ms。前述核心同步postconditions22/22另计，不与包含关系重复相加。
- 生产构建退出0。保留两项构建提示：部分压缩chunk大于500KB，vinext不能自动分类部分路由；不将提示隐去或宣称构建输出无警告。
- 当前源码/产物指纹一致：`401db336b719856f59707d8bb493446e23a699d76ba43a7f5dfeea47a38a96f4`。
- 全部分支变更TS/TSX文件（除`app/page.tsx`）ESLint退出0且无警告；`git diff --check 3ccc0ef HEAD`退出0。
- `app/page.tsx`仅新增一行传参，但整文件ESLint仍有10错误/7警告。用`.superpowers/sdd/xydc-page-lint-baseline.mjs`在内存分别lint检查点`c7c8875`和当前文本，按规则、严重度、消息及代码帧比较（只归一化新增行造成的行号偏移），10/7完全一致，无新增。因此不声称所有变更文件的全文件lint全绿。
- TypeScript当前341诊断；与保存的检查点341逐条文件/错误码/完整消息指纹多重集一致，新增0/减少0。`app/page.tsx`原8条仍在；报告中的“Task3文件0诊断”不应解释成这8条消失。全仓类型检查仍不通过，本次没有扩大范围修历史债务。
- GitHub push、main合并、正式服务切换/重启、真实西柚调用、第二台电脑实测均未执行；本文件不能作为上述未执行项的通过证据。

## 控制者最终验证（代码2de23bd；全分支审查通过）

- Task3独立末轮复审：Spec compliant / Task quality Approved，无Critical/Important。所有六项Important已关闭；等价新对象刷新保持弹窗、数据刷新展示当前5901、父体移除再加入不自动重开、延迟清理不关闭更新的主动选择均有回归。
- 控制者在锁定代码`2de23bd23a1cd394f58df49c5dd43750cbb10fc6`重新执行上面的UI和服务命令：UI13/13（约8425ms），六文件服务77/77（约2013ms），0失败/取消/跳过。
- 隔离生产构建退出0；仍显示chunk大小和路由分类提示。当前源码与dist指纹相同：`6a4d809826771f603be2da6dc9b0dbfe7cc9954b128581d5f2fa1e383f5b600e`。
- 分支变更TS/TSX（除有既有问题的`app/page.tsx`）ESLint和BASE到HEAD的diff-check均退出0。页面仅传参行变更，前述10错误/7警告基线不变。
- TypeScript当前341，逐条诊断指纹与开发前检查点341完全相同；没有新增，不代表全仓类型检查通过。
- 重新肉眼检查最新桌面/390px手机/详情截图：两列/单列布局、父体及输入ASIN、待采集仍保留变体资料、表格区域内部滚动、年度份额及选中父体详情正常。详情图显示5901是刷新后当前数据测试，非真实业务采集。截图仍在未跟踪的`test-results/`，不提交、不删除既有截图。
- 数据源接口身份与时间、真实临时缓存补测、已知全仓技术债及本轮未执行的生产/Provider操作边界与上文一致。
- 控制者在同一锁定代码再次执行完整核心同步postconditions：22/22通过（约164ms）。正式工作树HEAD仍为`deab0aa`，15/15个原有生成文件SHA256完全匹配开发前记录。
- 全分支审查过程曾提出Windows仅停止父PID可能留下付费子进程的候选问题。审查者随后在本机win32 / Node v24.14.0执行通用Node→spawnSync→Node离线探针，以独立loopback socket和子PID signal-0同时验证：外层已取消、父进程关闭、后代不存活、无存活回报、socket ECONNRESET，撤回该候选Important。探针无文件/Provider/业务写入；没有经过真实npm/订单CLI，不能推广为生产整链路取消或其他平台已验收。未因此修改通用worker。

## 全分支独立审查与交付边界

- 审查范围`3ccc0ef1b0ee2f22c4d58d454b213b508d76c733`至`2de23bd23a1cd394f58df49c5dd43750cbb10fc6`，单独的最终审查者读取完整分支差异及命名集成风险后给出Ready to merge Yes（技术批准）。三个分层任务均已Approved；没有确认的Critical/Important。
- 四项非阻断Minor明确保留：无效合同测试循环缺少用例名称（`tests/scripts/xydc-order-summary.test.ts:156`）；部分标签10–11px/月标签9px影响可读性（`app/comparison-layout.css:189`）；超过8子体颜色重复但ASIN映射正确（`app/xydc-order-card.tsx:33`）；SSR到hydrate恰跨UTC月边界时，独立时钟可能导致窗口不一致（`app/xydc-variant-section.tsx:125`）。终审确认它们不阻塞当前技术交付，未擅自扩展为另一轮界面重构。
- 正式激活前仍建议用离线fixture走真实npm/订单CLI链路验证取消及后代退出；本机通用Node探针和collector测试并不代替这一项。服务器其他平台也需独立验证。
- 本轮将实现和验证记录保留在本地功能分支；未合并main、未推送GitHub、未切换/重启正式服务、未修改真实生成数据或并行开发工作树。预览截图为离线测试数据，仍未跟踪。
- 全仓TypeScript与页面lint存在已核对的原有问题，因此只声明本次定向验收和无新增诊断，不声明全仓无问题。

## 最终验收记录

- [x] 同一固定窗口、全部子体分母、5900样本、未披露与缺失分离。
- [x] 独立缓存完整身份绑定、24小时/未来时间、跨月、部分补齐、失败刷新旧快照。
- [x] 2秒请求间隔、15秒单请求、300秒阶段、取消、429有限重试、认证/额度停止。
- [x] runtime先鉴权再读取，旧快照兼容，无GET/渲染触发采集。
- [x] 双列/单列布局、前3项预览、两父体详情隔离、全部子体/月度柱图、键盘焦点及普通ASIN链接。
- [x] 最终定向测试、变更文件lint、隔离构建/指纹、基线差异类型检查、截图肉眼检查、全分支独立审查。
- [x] 对比正式工作树HEAD和原有15个生成文件哈希；不自动合并、推送或切换正式服务。
