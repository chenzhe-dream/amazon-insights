# 模块三原版业务收尾与发布验收

## 本轮已完成

- 原版估算业务 5ef22ecb 随本轮发布：有效样本、W1–W5、归并、S1–S5/PVS、开发方向和验证优先级。真实来源字段保持不变，中性分和估算口径明示。
- 查询读取恢复：网络错误、408/429/5xx 最多退避重试五次；HTTP 200 响应流中断也能恢复；格式/身份/权限错误停止。保留报告及草稿，不重新提交采集。
- 模块三使用原有成熟月份组件，支持快捷换年，恢复结束月下界；采集复选框尺寸修正。
- 旧标签协议测试证明唯一差异来自已批准的多站点扩展，同时固定新旧身份和站点币种配对。

## 测试

49 项定向测试、8 项隔离 PostgreSQL/代理测试、7 项查询/草稿/历史浏览器测试通过；复核发现响应体中断和月份下界后，18 项边界及模块二月份回归通过。上述套件有重叠，不相加为不重复总数。typecheck 通过。生产构建通过（既有包体/路由分类提示保留）。

本地和正式桌面截图均查看；未开展手机版工作。正式临时普通成员账户完成后禁用，并撤销会话。

## 首次受控发布与线上证据

- 正式树：C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/publish-market-rules-20260922。
- a1ffab52 → 61ab72ca，fast-forward，未更改原有三个未跟踪临时图片目录。
- 回滚分支：codex/rollback-before-keyword-original-finish-20260928 → a1ffab52。
- 现有 manage-formal-stack.ps1 -PublishCode 空闲/归属检查、构建、重启、激活成功；Web 31900 和 Agent 31901 版本及源码哈希一致。
- 61ab72ca artifact：0660657fb1c46c71120205f4a4ac3df1c13d1d8f7a7e2806f3bdb59f3e4ac45c。
- 真实任务 41702503-2d36-4571-ac21-d652342c6667，100 词、100 有效原版样本、8 需求簇、95 词有参考月趋势值，评分全部有限数。
- 打开与刷新前后所有步骤尝试不变；浏览器错误 0。原版总结、评分、开发建议、月份组件显示正常。
- 仅重试原失败 ABA 步骤 6ad2bcc1-022e-488d-b20d-26d078bb56f9；其余步骤尝试不变。
- 取得实际结构证据：该批 keywords[1] 的 data_points=0，dates/volumes/ranks/top3_click_shares/top3_conversion_shares 五字段均缺失。严格数组校验导致整批拒绝，属于适配器兼容缺陷，非网络超时。
- 原诊断和截图保存在 test-results/keyword-finish-online-20260928/；日志 keyword-finish-online.log。

## 保留边界

1. 五个 Sorftime 趋势来源为空：floor lap、gloor lamp、floor. lamps、clearance floor lamps、livingroom lamp floor。保留缺失，不补零或替换原词。
2. S3/S5 及部分 S4 继续执行原版中性估算；真实供需比、SPR、关联商品均价属于后续数据增强，并非本轮假装已接通。
3. 默认原版 100 词已验收；高级最大 2000 词尚未完成容量专项，不能宣称全量规模已验证。
4. 最近查询仍是会话身份隔离的本地索引；服务端已有任务和人工报告可按 ID 恢复。跨设备最近查询列表待开发。
5. 多语言/全部站点完整线上采集、统一技术核对区权限属于后续验收；现有多站点协议有兼容测试，不等于全部来源实测通过。
6. 四模块自动联动和手机版按用户此前决定延后；本轮未扩展完整 VOC。

## ABA 补丁最终发布与线上恢复

- 补丁 d256942e4d3afc36758b4d2ab2bb2a6c9bf37303 再次经相同受控发布流程通过；artifact c25a5ee0b84344e0b839d01f42ca9cd3dd02ef2bbc4cee53c1aaca14caf018b5。
- Web/Agent sourceHash 同为 0c5f63924815077c33ca16a11290999431d787ee633635d6981bee065655b221，局域网 31900 健康。
- 补丁兼容数值 data_points=0 且字段缺失的真实空历史；显式 null/错误类型/正数缺字段/零条数却有非空数组仍拒绝；raw 原证据不改写。
- source/collector/evidence/隔离库 runtime 20 项测试通过；typecheck 通过；生产构建通过；只读代码复核无阻断项。
- 真实任务定向重试成功，10/10 ABA 步骤 succeeded、失败 0、任务 succeeded。该步骤从原第 1 次失败、取证第 2 次失败变为第 3 次成功；其余 9 个 ABA 及所有分页/趋势步骤尝试均未改变。
- 最终 100 词、100 原版有效样本、8 需求簇、95 参考月趋势值；前述 5 个空趋势保留。浏览器错误与非预期写请求均为 0。
- 最终 source-status.png 已查看，页面显示“步骤已完成 / 趋势已完成100/100（5词来源为空）/ 失败步骤0”。重新打开/刷新不会采集。
- 首次诊断另存 before-aba-empty-fix.json；最终 result.json 与 run.json 反映补丁后的状态。临时验收账户禁用、会话撤销。

可用入口：http://192.168.1.109:31900/?tab=market-overview&themeView=keywords&keywordRun=41702503-2d36-4571-ac21-d652342c6667
