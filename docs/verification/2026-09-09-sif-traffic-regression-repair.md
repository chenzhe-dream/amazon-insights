# SIF 流量格式与明细修复：本地验证记录

日期：2026-09-09。用户批准本地修复；本文件不是正式发布证明。

## 工作区与补丁对应

- 开发目录：.worktrees/fix-voc-import-status-20260907；分支 codex/feat-xydc-parent-orders-12m-20260908。
- 初始 HEAD：6d278f86567f05b757ceaf08e2ea677c54adb65c；授权计划提交：23983cb3f173eb0325db3b78dd8406129f4ef883。
- 生产投影提交：5c26afd1f1879e515fb8e59a53e0ccad647e6ea1，审查补充 b3eb14314547badf6bfebfaf86d379f1c87a9d26。
- 消费者初稿 f53dcbf、报告更正 bcb2a37 不可单独移植；必须包含后续 root 的消费者/UI/生命周期修正。
- 已验证本地代码候选：001fa194c4334b6d52531e8b6839ea9f14946301。
- 本地构建完成时间：2026-09-09 18:54（Asia/Shanghai）；dist/build-fingerprint.json 的 sourceHash 为 c5654860fb8f8ac5a4e2a423fb11a057a58548e873a364c0d166d68e62039b4b。后续文档提交不改变此次受测代码/构建输入；正式集成仍须重建。
- OpenSpec 并行 owner 已确认 traffic 路径无重叠写入。既有 progress.md、9月8日正式发布报告、private-presence 文档、test-results/ 不纳入此次提交。

| 历史参考 | 本次适配 |
| --- | --- |
| 123c261 | 完整白名单投影；四广告渠道、推荐前六项、子体原索引匹配和畸形 ASIN 过滤 |
| 6280800 | 字段级合并、整数分值/一位小数占比；unknown/null/invalid/empty 区分 |
| 3e4d594 | 保留来源匹配要求，但不恢复默认全局缓存；摘要不冒充渠道/推荐/子体明细 |

## 实现与三款基线

- 新任务投影保留 naturalAd、adChannels、recommendationSources、children、updatedThrough。推荐仍为得分大于0、份额至少1%、降序前六项；原始证据不被显示精度改写。
- 精简字段不清掉同范围已接受明细；零、空数组、null、畸形输入分别处理。无 snapshot、pending、403/404/503 不借编译全局流量冒充当前任务。
- 摘要与 stage 双路径绑定会话/组织/任务；立即隐藏旧数据，拒绝迟到响应，owner token 防 A -> B -> A 恢复旧 receipt。
- 同 owner 的已完成任务切 tab、清 syncJob URL 仍保留明细且不额外轮询。cleanup 使用 owner-disposed 标签，与真实空 retry 更新区分。
- 证据不足不生成推广评分；没有改已有月度图算法/布局。几何测试通过，无需 CSS 调整。

| ASIN | 已知子体 | 自然分 / 占比 | 广告分 / 占比 |
| --- | ---: | --- | --- |
| B01E6CX34C | 11 | 128,266 / 47.6% | 141,361 / 52.4% |
| B07Y4PJJR4 | 2 | 9,381 / 41.5% | 13,240 / 58.5% |
| B07WFC14VR | 6 | 123,897 / 67.1% | 60,691 / 32.9% |

浏览器 fixture 的逐子体、渠道和推荐内容为合成明细，不是历史真实明细恢复声明。测试挂载生产 AuthenticatedAmazonOpportunityApp 和生产 CSS，未复制一份近似页面。

## 历史来源审计（只读）

- 项目：03ee45fb-231f-491e-92cf-c763fa0c567f。
- run：c39a954a-7dc1-49ba-be86-07387731814b。
- job：81f00bbf-0a3e-4e67-91e5-10cf32be908a，v11 completed。
- snapshot：9ccaaa61-80f1-4a03-b142-57ce41a82f55。
- snapshot 创建时间 2026-09-09T05:45:03.842Z，内容 hash 6807a320bc316ff3a90eb956d9fef66bc3ebed1513034bc0c75e34cee3c249e8。
- stage output v1 更新时间 2026-09-09T05:48:51.274Z，内容 hash af6e351b08b5b25fa09fd68934abf36b8326afae040d8d19f0fe49b33ae493a2；关联产物提交时间 2026-09-09T05:49:58.005Z。
- 审计时正式 raw 文件 SHA-256 为 0931f70b58317d467a40557e9b9d9a3fda508b6023ed931b52550527da13ea5d。它是文件完整性记录，不是同批请求来源证明。
- 摘要证据链及 11/2/6 子体数量已确认；完整明细与同批采集的关联不能确认。
- 当前 raw cache 校验和不同，且原生成器是有损摘要转换：不能证明缓存一定错误，也不足以满足同批证据门槛。
- 未更新业务表、未伪造 provenance、未补入不明缓存、未重跑 Provider。旧任务仍应显示“已识别 N 个子体，明细待补齐”。

## RED 与审查修正

1. 生产 RED 失败于丢字段；追加 RED 失败于无合法 ASIN 的对象保留。修正后生产组36/36。
2. 消费者初稿测试不足，root 补逐字段状态、独立 receipt 和真实页面验证。初稿30个通过不构成最终验收。
3. 浏览器 RED 复现 128,266.498 而非 128,266、已知子体缺失文案错误。纯 formatter 边界是在实际 precision RED 后补齐，不冒称所有边界先于实现。
4. 结论 RED 复现未知自然流量被当零评分，增加证据 guard，不改评分算法。
5. 全量回归发现四个终态重复 GET/完成回调：初次 effect 清掉 terminal seed。改为初始化 owner ref 后仅真实身份变化才 rearm。
6. 登记测试漏 mock runtime API，产生独立后台提示竞争。登记/刷新生产代码与基线逐块一致；仅补合法空 runtime fixture，保留原失败提示和禁止 POST 断言。未声称产品提示优先级已修复。
7. 终态 tab-return RED 超时；修正 scope/disposal 后通过，追加 ABA、迟到双200、清终态URL、GET次数断言。
8. 独立审查要求补 formatter 异常边界、权威 empty/invalid 页面状态与精确广告值，均已补齐。最终两个只读审查均 Approved，无 Critical/Important。

## 最终本地验证

以下为末轮完整命令结果，代码随后原样提交到上述候选。测试无失败/跳过，合计180项（含15个实际页面浏览器用例）。

| 检查 | 结果 |
| --- | --- |
| npm run test:traffic-regression | 36 + 51 = 87，通过87，失败0，跳过0，exit 0；分别0.78s / 64.16s |
| tsx --conditions=react-server --test tests/agent/asin-sync-session.test.ts tests/agent/stage-output-route.test.ts tests/agent/traffic-snapshot-read-route.test.ts | 93/93，失败0，跳过0，exit 0，200.81s |
| TypeScript --noEmit --incremental false / 同配置只读 compiler fingerprint | 基线339，当前334，新增fingerprint 0；全量仍有旧错误，不宣称tsc全绿 |
| 受影响文件 ESLint | page基线10 errors/7 warnings，当前8/7；其余13个受检文件0/0 |
| npm run build | exit 0，7.99s；vinext五阶段成功，保留大于500kB chunk提示，未改拆包策略 |
| git diff --check / git diff --cached --check | exit 0；本次代码均已按明确文件清单提交 |

浏览器覆盖1280/1920px、100%缩放、正文/title一致、数字无跨列重叠、TOP3和展开、两种响应顺序、刷新、缺失/空/异常、权限失败、会话/组织/登出/ABA、任务切换、终态tab返回。仅连接本地隔离fixture；任务写入及外部Provider请求计数均须为0。

## 边界与后续集成门槛

- 发现 Sites 配置后，按单 owner 规则由 root 负责 checkout，代理只读审查。Task2/3 的 nullable view 与 UI 必须一起成立，作为一个完整本地候选提交。
- 额外最小改动：asin-sync-funnel.tsx 会话/清理生命周期、traffic-analysis-conclusion.ts 缺证据 guard、实际页面 harness；不是 VOC 或月度扩展。
- 未移植最终集成目录，未推送、发布、重启。正式目录 integrate-xydc-variant-20260905 的 HEAD 仍按只读基线 fff8c3ec097ab52c5a8f74eb278a2558ac6b7981 管理，既有生成文件修改不触碰。
- 构建后只读复核正式 HEAD 未变，仍为上述提交，15个既有生成文件修改和 test-results/ 保留。没有从本地检查推断正式页面已修复。
- 之前只读记录的正式artifact：d8a62ee5ec5717e30f75c4b35f9c122c47844729b5397da4aa03b87b032a82f9，不是此次候选。
- 获得正式窗口后，将完整代码/测试/入口移植，在最终候选再跑同组测试和构建；用 scripts/manage-formal-stack.ps1 受控发布，核对实际 codeRoot/commit/artifact、健康和浏览器结果后才可说正式修复。
- VOC persistence、事务一致性及标准化耗时属于独立待处理事项，本次未修。
