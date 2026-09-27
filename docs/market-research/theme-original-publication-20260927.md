# 第四模块原版恢复发布记录

用户明确要求“先发布”。2026-09-27 已完成正式发布。

- 正式代码：`e1c77560b28b96fbb922015fec25d6f699cafadf`。
- 正式地址：http://192.168.1.109:31900 。Web 31900、Agent 31901、PostgreSQL 58258。
- 制品：`a76cd82b396083411337a332e9ec9622b06d837c45e8c41763e68793edc835e5`。
- 前后端源码摘要均为 `ece98dec91b1fb8aa0f373c76893d7bf3b1e2667b598de645327e84b3bec60eb`。
- 回滚引用：`codex/rollback-before-theme-original-20260927`，指向发布前 `40f1ed8b`。

发布前确认正式工作树无已跟踪修改、活动任务 0；保留三个现有未跟踪临时目录。仅快进本次候选提交，以 manage-formal-stack.ps1 -PublishCode 完成受控构建、服务重启和制品激活。前后端健康均 ok，LAN 健康接口 HTTP 200。

## 页面检查

登录后的真实第四模块入口、英文类目输入提示、CSS 网格加载、刷新恢复和 390px 无页面溢出通过；无浏览器脚本异常。截图、脱敏健康结果保存在 test-results/theme-original-online/。临时验证账号已禁用，登录会话已撤销。

此轮没有发起真实供应商采集；新版成功/部分成功流程沿用发布前隔离数据库测试证据，不能视为正式真实来源已验收。

## 新发现的历史兼容问题

正式库两条早期 market-theme-flow/v2 空报告读取返回 409。原始报告缺少当前重建输出的 ruleStatus/semanticStatus，导致报告哈希不匹配。

- e5f3f10c-b8a4-4118-b0ac-014774953f5a
- befcc9f2-dc18-436f-9bbf-216ef95273f7

只读对比发布前 40f1ed8b 与本次 e1c77560 的 createMarketThemeReport：两版重建结果完全相同，且均与保存输出不符，确认不是本次引入。未改写历史报告，未放宽校验；该兼容问题尚未修复，应单独处理。验证期间所查旧任务 attempts 仍为 3、models 为 0，无新增采集。
