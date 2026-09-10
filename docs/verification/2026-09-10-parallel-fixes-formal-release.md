# 并行修复正式发布与 Sorftime 即时核验

## 发布授权和范围

用户明确要求“发布一下，然后目前的 sorftime 数据源是否正常”。发布已有审查候选，保留正式数据；不重跑整批任务，不回填旧任务，不执行真实项目删除。此前单独授权的 26 个测试项目归属绑定保持不变。

## 激活证据

- 正式根目录：`C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/integrate-xydc-variant-20260905`。
- 正式代码从 `4bb38d966787de7216ec4aae96a945a0c0a5a4f1` 无冲突快进到 `6c515b75b7f2c5a318a59586e90edaf3fc5a30c5`。15 个现有 generated 文件的本地改动和原 test-results 目录保留。
- 通过 `scripts/manage-formal-stack.ps1 -ProjectRoot <formal-root> -PublishCode` 发布，退出码 0。管理器在构建前后检查活动任务、进程归属和健康状态。
- 正式根目录附加回归：56/56 后端/权限/VOC 测试和 64/64 provider/阶段投影测试通过；受控发布执行的 vinext 五阶段构建成功。原有大 chunk 与静态路由分类提示仍存在，不声称全仓类型检查干净。
- Web 本机、Web 局域网 `192.168.1.109:31900`、Agent `31901` 均 HTTP 200 / status ok。
- Agent / Web sourceCommit 一致：`6c515b75b7f2c5a318a59586e90edaf3fc5a30c5`。
- Agent / Web sourceHash 一致：`5dd3d3116f23c27ee3535d5520df47e8eaabe6ac4d7254e6a1a958bdf0923b16`。
- 新 Web code artifact：`014ffe0b530e4dd14b600d780fd8fe51f6c9907d3fcb0303be04245bdb8b91c1`。
- 原业务 data artifact 仍为 `2027909139fa44f1db8b8106bc6fd73d17c5e8937369c8681516cab8afebdd8d`，作为 dataCurrent 和新代码的 baseArtifactId 保留。
- 发布前后 sync_jobs / run_stages / job_attempts / analysis_runs 的 queued/running 数量均为 0。
- PostgreSQL 58258 监听进程仍为 51004，未重启；新 Agent 56312，Web 41244。

## 数据保护与回退材料

私有备份：`C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/parallel-fixes-release-20260910-0600`。

包含原 formal-stack.env、管理器状态、current-known-good 指针、15 个 generated 文件、30 个项目文件，以及原不可变 Web artifact 的 72 个文件。旧 artifact 已逐文件核对散列。首次复制时按无前缀 artifact 路径未找到，随后使用实际 `publication-<artifactId>` 路径完成复制与 72 文件验证；未把首次复制错误当成备份完成。

发布前和发布后均核验 15 个 generated、30 个项目和配置，共 46 个文件与备份逐字节一致。保留旧版本和私有备份用于受控回退，不自动覆盖数据库或项目后续更新。

## Sorftime 即时实测

使用正式配置中的凭据、项目生产 MCP 客户端和 PostgreSQL resource governor；不是技能包的另一套账号或缓存。依据真实任务 `2f37a6e3-5ef0-4561-a6dd-359096876b72` 的组织范围执行有限诊断，单次 20 秒超时、串行、无重试循环，不输出原始评论或密钥。

先实时 tools/list 核验参数：97 个工具，290 ms。product_reviews 使用 amz_site / asin / review_type=Both；product_customers_say 使用 site / asin；均选择 US。

| ASIN | 评论样本 | Customers Say 主题 | 接口结果 |
| --- | ---: | ---: | --- |
| B0CZRBL776 | 0 | 0 | 两次调用成功，返回上游空数据 |
| B0BHHP21DP | 70 | 0 | 评论与主题接口均成功 |
| B09NNDX731 | 3 | 0 | 评论与主题接口均成功 |

另测 B0BHHP21DP product_detail，成功返回对象。以上 7 次业务调用耗时 124–304 ms，无 HTTP/RPC/超时错误；加 tools/list 共 8 次实际成功诊断请求。首次本地元数据查询错误使用 version 列，在发出上游请求前失败，修正为实际 job_version 后继续；不计为 Sorftime 调用失败。

结论：测试时正式凭据与 Sorftime 接口可用，不能据此保证所有 ASIN/所有模块有数据。零评论是此接口返回的可用样本数，不是商品真实总评论数为零；无 Customers Say 不代表顾客没有对应需求。旧页面/旧任务已持久化的错误不会被纯代码发布或本次只读诊断自动回填。

除 governor 的诊断配额/permit/attempt 记账外，本次数据源检查不写入业务任务、模块结果或数据产物。未调用真实 DELETE；正式登录后的点击删除验收由用户完成。
