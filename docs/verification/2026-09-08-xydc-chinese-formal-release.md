# 西柚中文显示与本地正式发布验收

## 授权与候选

用户批准补齐颜色/规格中文显示并更新 31900 原模块，网址与位置不变。候选包括此前已批准的完整 12 个月年度模块及 V2 交互/采集保护，不只是翻译补丁。继续不新增月度交互/投影或饼图，不操作 main/GitHub，不调用真实 Provider，不伪造会话或业务来源。

源根 `fix-voc-import-status-20260907`，分支 `codex/feat-xydc-parent-orders-12m-20260908`。中文任务基线 `1fc1b493ae2f1f7b515367e3f6305c455262773c`，源实现 `8f70e7df994f674177af0b3a54271b8458b37600`。此前年度模块与 V2 整分支审查/219 项测试见同目录 parent-orders-12m 与 annual-v2 报告；本次复用既有证据而不宣称全部历史问题已修复。

## 本次新鲜验证

- 受控 manager / formal root：25/25，12280.3793ms。
- code publication / durable control / artifact store：44/44，28832.2969ms。
- Agent/Web health / scoped runtime / order-cache reader：31/31，2685.5831ms。
- 中文 helper 与实际卡片/年度检查面板/弹窗/移动端/进度 owner：根协调者锁定最终 8f70 后 33/33，18185.4315ms，失败/取消/跳过均 0。
- 以上本轮定向验证共 133 项，不包括重复计数的实施者 32 项中间矩阵与 7 项最终 focused run。实施者记录初始英文差异 RED、GREEN 及 prototype-key RED/GREEN；Map 查找确保 constructor/__proto__ 未知属性原样回退。
- 根协调者 4 个变更文件 ESLint / 增量 diff check 退出 0。UI 工具有原有 Vite optimizer 与端口自动让位提示，不计作 pristine 全仓声明。
- 全仓 TypeScript 仍 341 项；文件/错误码/完整消息 hash 多重集合与 V2 最终基线完全相同，无新增。
- 隔离 `npm run build` 退出 0；source/dist 指纹均 `c4b91069c8a15e1c19cbce8df54fccba0ac99b6fa60399f4af597f6189d72988`。保留既有 >500kB chunk / 静态路由分类提示。
- 后台浏览器真实缓存组件验收：21 个子体的颜色/规格中文；年度 5900+/3750+/59450+ 不变；砂黑色年度明细 4000+/67.80%，未知值和原始商品标题不覆盖。截图 `test-results/xydc-chinese-annual-panel.png` 已肉眼检查。
- 后台浏览器最初受 auto-connect 配置影响启动失败；显式 `--auto-connect false --headed false` 后独立会话正常。没有接管用户 Chrome。正式 `/p/project-us-5` 在独立会话要求登录，因此未伪造登录后正式页面的端到端验收。

## 正式预检与回退材料

正式根 `integrate-xydc-variant-20260905` 原 HEAD `deab0aae8f7d5a04fd7787a0292f4285fa7cabae`，为候选祖先。index 空，15 个原有 generated 文件及 test-results 保留，无传入路径重叠；旧 Web artifact `043a0f072ffa0fa74f4d8228bc6bfe579fd01e6d5228c9d94cd499cbdbacea6a`，source hash `47d0235c16d15ac517e4173bc65ceb9de6782887a77f0f61b1b7fa59010f7628`。OpenSpec 窗口独立确认无并行所有权/发布冲突，允许按既有授权与门禁继续。

新鲜预检 active=0、owned=true、Web/Agent 健康、PostgreSQL 58258 一个监听、3000 无监听、pending/processing 空。真实业务计数：VOC revisions 21、heads 21、snapshots 79、analysis runs 61、Agent runs 73、attempts 79。没有新增 migration 或发布器/manager 差异。

备份目录：`C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/pre-xydc-chinese-release-20260908`，含原 formal-stack.env、stack.json、current-known-good.json 和 15 个生成文件副本。保留原不可变 artifact 与 durable dataCurrent/streams；不覆盖指针或停 PostgreSQL。此次没有执行数据库恢复；无新迁移时以现有恢复材料和只读计数为边界。

正式配置只增加 `XYDC_COORDINATION_ROOT=C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/xydc-coordination`，创建独立空协调目录；逐行验证其余配置相同。未复制凭据给其他工作树，未共用整个 data/runtime 根。

## 年度数据单独授权边界

预检正式 data 只有 projects / xydc-variants，没有 xydc-orders。已校验之前真实采集的三个快照：当前 US 父子集合与固定 2025-09 至 2026-08 窗口匹配、21 子体/252 月数据、采集时间仍在 24 小时内；正式合法目标均不存在。

已向用户异步询问是否导入。未得到明确答复前不导入、不重新抓取、不消费额度。代码发布不能冒充年度数据已经进入正式环境；正式缺数据时必须如实待采集。全部 36 个既有共享业务文件记录 hash 以便发布后比对。

## 激活结果

中文 Task 独立审查 Spec compliant / Approved；最终交付审查 Ready to integrate/publish Yes，均无 Critical/Important/新增 Minor。四项历史非阻断 Minor 仍沿用旧报告，不伪称已消除。

正式目标通过 FF 集成至 `8f70e7df994f674177af0b3a54271b8458b37600`；前后 15 个 generated hash 完全一致。目标根额外运行完整 33 项中文/UI 回归：33/33，18354.3361ms；这是重复目标验证，不累加为 166 个独立用例。

唯一激活命令为原有 `manage-formal-stack.ps1 -ProjectRoot <正式根> -PublishCode`，退出 0。它在停止旧服务前完成正式环境构建和第二次 active/owned/health 门禁，随后完成真实 source/current/applied/health 一致性核对。

| 实际运行身份 | 值 |
| --- | --- |
| Web/Agent/source commit | `8f70e7df994f674177af0b3a54271b8458b37600` |
| 新 Web artifact | `337affd01ac62b2bd1c54ae850717de40c2225f23dbb8d1e9ef8d3efc0a02e49` |
| 应用请求 | `49fe12fb467b1e51c4c96523025daf103dc952a365240064cc31eba55b92e82c` |
| 正式源/dist/immutable sourceHash | `321dc61cf87700371f303b5a69c89524bd920a7752a3190587b6c5b8997b674f` |
| 新 code base | 之前的 code artifact `043a0f07...`，未回指/伪造业务版本 |
| 新 supervisor | `56224` |

root 独立后验：Web/Agent 健康，精确请求 applied，owned=true，active=0，PostgreSQL 监听 1、3000 为 0、发布队列空。15 个正式生成文件及全部 36 个共享业务文件 SHA256 与发布前完全相等；VOC revisions/heads/snapshots/analysis runs/Agent runs/attempts 仍为 21/21/79/61/73/79。durable dataCurrent 和 streams 与备份深比较完全相等，旧包保留。没有年度缓存目录或真实 Provider 请求。

正式页面位置/URL 保持 `/p/project-us-5`；本机 31900 健康，新独立浏览器会话仍显示正常登录门禁。登录后正式项目 UI 需用户已有登录态人工确认；组件中文/年值验收来自已标明的真实缓存隔离页，不冒充 authed 正式端到端验收。

LAN 地址实机仍为 `192.168.1.109`；同机直连 `http://192.168.1.109:31900/api/health` 返回 200 和新 artifact。加载正式配置的诊断 shell 默认代理请求为 502，同一进程 `-NoProxy` 为 200，已定位为诊断代理路径而非服务未监听。没有改动用户代理、网络设置或浏览器；未从第二台物理电脑验证。

两个独立 browser 会话已关闭。31911 只读验收辅助进程保留为当前中文版本，不是正式入口；没有启动新的产品页面。年度快照导入仍待用户另行明确选择，不纳入此次代码发布完成声明。

OpenSpec 只读联合终验 **Approved**，无发布一致性/运行身份/数据保护阻断发现。其独立核对正式 HEAD/index、Web/Agent/LAN 直连健康、源码/dist/immutable/current 指纹、严格请求 payload/hash/applied/target、保留 code base 及 dataCurrent/streams、manager 所有权/根/端口/队列、READ ONLY 事务下的 active 与六项业务计数、15 个生成文件备份 hash、正式 env 单键差异及空协调目录、main/origin-main 不变。

联合窗口独立确认共享业务文件现存 36 个、无 xydc-orders；全部 36 文件前后 hash 相等沿用 root 的发布记录，不宣称该窗口重建了不存在于备份中的前态清单。联合窗口没有重跑测试/构建、改配置、部署、Provider 或业务写入；登录后正式 UI、真实 Provider/年度数值齐全及第二台物理 LAN 客户端仍未验收。此回执只补文档，正式目标和运行版本保持 8f70，不再次触发发布。
