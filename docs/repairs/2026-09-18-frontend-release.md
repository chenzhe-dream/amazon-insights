# 2026-09-18 前端发布

用户授权发布：竞品参数总览全屏、子体属性颜色展示、VOC 隐藏缺失提及占比前缀。

## 结果

- 通过 `manage-formal-stack.ps1 -PublishCode` 完成正式发布，Web 31900 / Agent 31901 / PostgreSQL 58258。
- 当前 artifact：`aa09a05e6e163c490685621e46bee71f92fc50a40b6ab9a94685167338b59b04`。
- 前后端 sourceHash 一致：`5c8f40fec2366b06d628cfd937e0268d5ebba59eb23f24df51b532d080a4776c`。
- 本机与局域网健康检查均 HTTP 200；七类任务队列均空闲。
- 正式资源 `page-DhVqT-hM.js` / `page-Dem2RYai.css` 与本机构建字节完全一致，包含全屏、属性颜色说明、VOC 文案规则和全屏样式。
- 发布前已有 14 份模块配置的内容散列保持一致；发布过程中新增 1 份配置，因此全量配置散列变化，经按更新时间重建发布前集合核验，无旧配置被改写。
- 正式配置及 dataCurrent 保持不变，无新增迁移和付费分析请求。

## 等待与诊断

首次构建成功，但临时 artifact 目录原子重命名遭遇 Windows EPERM。关闭本任务的 56508 Vite 预览进程后，相同源码和构建成功完成准备。

随后正式环境有新 VOC 任务进入，发布脚本按保护规则等待。最后的定位任务于北京时间 09:38:02 启动，09:43:03 记录 `UPSTREAM_TEMPORARY`，09:45:07 检查时全部队列清空，发布自动继续。用户确认已备份并要求立即更新后，任务已自行退出，无需手动取消或更改数据库状态。

## 证据

`.superpowers/sdd/frontend-sept18-release-final.log`、`frontend-sept18-release-before.json`、`frontend-sept18-release-after.json`、`frontend-sept18-release-final-verification.json`、`frontend-sept18-release-assets.json`。

正式入口：`http://192.168.1.109:31900/?tab=overview`。登录后的真实业务验收由用户进行；本次核验包含正式服务和实际 HTTP 资源，交互回归已在本地浏览器通过。
