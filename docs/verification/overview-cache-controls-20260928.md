# 总览缓存读取与重新采集入口

范围：继续已授权的缓存改动，明确已保存报告与主动采集的区别。总览缓存保存时限仍待业务确认，本轮不改查找排序、TTL、原版评分和历史来源。

- 总览报告顶部新增“重新采集”，使用上方当前筛选条件和设置中的起始月新建任务，复用已有创建接口；不删除旧任务或报告。
- 显示当前任务创建时间（用户浏览器本地时间），明确其不是供应商的数据更新时间；读取已保存报告不会重新采集。
- 当前同条件任务进行中时禁用重复提交；不同条件可启动新任务。成功提交后新命令、失败不确定时原命令的既有幂等规则保留。
- 最近30天与自然月保持独立查询身份，GET历史读取不触发供应商。

验证：新增页面期望先失败（缺少入口与时间），改后页面与查询缓存6项通过；数据库入口、并发幂等、只读查找、形态7天过期和强制刷新12项通过；TypeScript检查通过。本轮不宣称全项目测试全部通过，已知旧测试边界列于四类清单。

四类完整清单见 `modules12-four-category-checklist-20260928.md`。

## 发布与正式验收

- 正式版本3caa7f7a1c092b02a1728389386b7a725f2fad42；制品eab7edd7ffbbc83328719d828c1d7938fc4962b5725a27ec496315b31dbadf8c；sourceHash bbca8375563779ded7790f6e090afc833d414b61e7c418fbfff83b11a182d435。Web31900/Agent31901健康。
- 回滚引用codex/rollback-before-overview-cache-controls-20260928指向a331044f。
- 正式页面显示任务创建时间与重新采集入口；两次点击生成不同研究和任务命令编号。采集POST使用受控返回，未新增供应商调用；真实后端幂等行为由数据库回归验证。
- 原报告读取使用真实接口；所有历史步骤ID/output_hash不变，浏览器错误0；截图已查看。验收临时账号停用、会话撤销。
- 证据：test-results/overview-cache-online/{result.json,cache-entry.png,repeat-submit.png}，overview-cache-publish.log，overview-cache-typecheck.log。
- 页面同时暴露基础概览默认最近记录与历史详细报告可能不同范围的问题。核实app/market-research-section.tsx的refresh默认rows[0]且onRestoreScope只更新筛选；已归入四类清单C6待修，不宣称缓存相关体验全部闭环。
