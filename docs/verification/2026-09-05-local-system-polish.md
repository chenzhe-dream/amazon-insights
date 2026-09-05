# 本机正式版小问题修复与验证（2026-09-05）

工作目录：`C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\release-main-merge-20260903`

修复分支：`codex/fix-local-system-polish-20260905`；基线：`8e3335e`。

## 已复现并修复

1. 教程弹窗的 Tab / Shift+Tab 可以跳到背景控件：增加焦点约束，关闭时恢复焦点。
2. 修改密码弹窗未锁定背景滚动、键盘可离开弹窗：复用相同的弹窗交互约束。
3. 关闭并重新打开教程后，旧的异步复制结果仍会显示“已复制”：隔离每次复制及弹窗会话，清理旧计时器。
4. 反馈请求延迟返回时，会清空关闭后重新填写的新草稿：按提交代次隔离成功、失败和 pending 状态；卸载或关闭时使旧结果失效。关闭不会撤回已经发送到服务端的请求。

教程截图改为直接显示原始 PNG，避免再编码及不必要的框架图片依赖。未修改截图内容、未声称提升原始分辨率；高清截图仍需替换原素材。

## 回归测试维护

- 同步页面测试路由模拟器保持对象身份稳定，避免模拟器触发无限 effect 重跑。
- 同步回归中的几处固定 100/200ms 等待改为等待实际页面或请求状态，不改变调用次数、权限及数据隔离断言。
- 旧 VOC 回归补充当前要求的 projectId / runId，按现行响应字段验证；直接解析测试使用完整结构化报告。没有放宽生产校验。
- 反馈端到端测试补充真实有效的数据库会话，兼容在线心跳；按现行 JSON 图片传输协议断言。
- 管理员页面静态渲染测试临时处理 CSS 模块，样式和交互仍由构建产物的浏览器测试验证。
- 同步超时断言保留每个 ASIN 的诊断信息。

## 已完成的检查

| 检查 | 结果 |
| --- | --- |
| 鉴权、钉钉、VOC、同步服务等定向测试 | 430 / 430 |
| VOC 回滚、立即读回、工作区隔离和历史快照 | 6 / 6 |
| 管理员页面静态渲染 | 7 / 7 |
| 失败阶段修复入口权限与提示 | 3 / 3 |
| 教程、密码、反馈草稿的构建产物浏览器回归 | 9 / 9 |
| 反馈上传、查看、管理员处理的真实代理 + SQLite 端到端测试 | 1 / 1 |
| 正式启动、VOC 解析、同步进度和续跑脚本 | 40 / 40 |
| 同步页面完整场景 | 最新全量 79 / 80；剩余一项为测试等待不足，修正后单独补测 1 / 1 通过 |
| npm run build | 通过 |
| 本轮生产文件 ESLint | 0 错误；登录页现有 img 建议警告 1 条 |
| git diff --check | 通过 |
| 本机 PostgreSQL 部署前检查 | 连接正常，活动任务 0 |

上述共覆盖 576 个不同用例；同步页面最后一项为补测通过，不是声称最后一次全量执行 80 / 80。

浏览器测试使用独立的无头浏览器及随机测试端口，没有接管用户的 Chrome。测试使用隔离数据或模拟上游；没有重新扫码登录钉钉，也没有调用付费模型或真实商品连接器验证外部服务。

## 复跑命令

在上述工作目录中执行。浏览器回归使用已经构建的 dist。

```powershell
npm run build
node --test --test-concurrency=1 tests/agent/alexa-voc-tutorial-browser.test.mjs tests/agent/password-change-modal-browser.test.mjs
node --import tsx --conditions=react-server --test tests/agent/help-feedback-browser.test.mjs
npx tsx --test tests/agent/primary-admin-page.test.ts tests/agent/sync-failed-stage-repair.test.ts
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-rollback.test.ts tests/agent/asin-sync-session.test.ts
node --test tests/scripts/manage-formal-stack.test.mjs tests/scripts/parse-alexa-voc-report.test.mjs tests/scripts/sync-job-progress.test.mjs tests/scripts/sync-job-resume-selection.test.mjs tests/scripts/sync-command-diagnostics.test.mjs
```

430 项服务测试的选取规则（客户端渲染测试需要上面单独的运行环境）：

```powershell
$auditFiles = @(rg --files tests/agent | Where-Object {
  $_ -match '(auth|dingtalk|alexa-voc|sync-|primary-admin|feedback).*\.test\.ts$' -and
  $_ -notmatch 'postgres|browser|agent-run-budget|alexa-voc-legacy-source|asin-sync-session|primary-admin-page|sync-failed-stage-repair|manual-alexa-voc-rollback'
})
npx tsx --conditions=react-server --test --test-concurrency=2 @auditFiles
```

## 未宣称解决的范围

- `npx tsc --noEmit --pretty false` 全库检查仍失败，当前有 342 条类型诊断，涉及大量现有测试和其他服务模块。本轮四个生产代码文件未出现在诊断中；没有把这次构建成功等同于全库类型检查通过。
- 构建仍有大 chunk 建议，登录页已有原生 img 建议警告。这些未作为功能故障擅自进行大重构。
- 本轮没有更改钉钉凭据、管理员角色、账号、业务数据库内容，也未合并其他 OpenSpec / 变体模块工作树或推送远端。
- 本记录是定向回归结果，不是整个系统不存在任何未知问题的保证。
