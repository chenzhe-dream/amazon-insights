# 并行修复：本地合并审查候选

日期：2026-09-10。用户要求修复后合并，再由用户审查。

## 审查位置与范围

- 工作树：`C:/Users/EDY/.codex/worktrees/5b97/feat-voc-positioning-skill-execution`
- 分支：`codex/integrate-project-delete-voc-sync-20260910`
- 对比基线：`3c860d3cdbaee5d0686bf0d43718f61891c2452f`
- 三线合并提交：`c4eaf57eaebea503ebf4723e0de78463e3ca5ffd`
- 保留原候选历史：删除 `837f935` / `bdaf4f8`；数据源及进度 `cfbb797` / `b1bfab5` / `e2ec50e` / `8b6b6f1`；评论展示 `2db208e`。
- 合并无冲突。删除回调和 VOC 页面读取逻辑均保留。

这是本地代码审查候选，不是正式发布，不表示所有业务阻塞已解决。没有推送、部署、服务重启、正式项目删除、归属绑定或正式任务数据修复。

## 已验证的行为

1. 历史项目恢复单独的管理员删除入口；取消收藏只移除收藏标记。删除接口统一校验登录、管理员角色和可信组织绑定，失败保留列表。
2. 明确的无评论、无关键词记录、空类目节点不再误报结构错误；未知或冲突响应仍拒绝，不伪造价格、费用、销量或主题。
3. 同阶段逐 ASIN 完成时保留其他已成功结果；计数采用完整任务范围；重试恢复后旧错误不再进入当前缺口。
4. VOC 直达页独立读取受认证范围约束的阶段结果；矩阵与七维汇总同源；显示样本量、主题量和中文状态。
5. 完整生产页面组件的隔离测试覆盖直达 VOC、刷新、旧全局缓存错误不覆盖新投影、终态停止读取、只读页面不发起写入。测试使用合成数据和既有认证/路由 harness，不是正式用户登录验收。

## 合并后验证

- 数据源、解析器、阶段结果及恢复：156/156 通过。
- 删除、认证、收藏、VOC 读取、范围隔离、旧聚合行为：84/84 通过。
- 收藏组件、完整删除页面及 VOC hook 浏览器测试：9/9 通过。
- 新增完整 VOC 页面集成测试：1/1 通过。
- 合计 250 项针对性测试通过，不等同于全仓测试全部通过。
- `npm run build` 的 vinext 五阶段构建成功；存在大于 500 kB 的 chunk 提示及框架路由静态分类提示。
- 新增集成测试 ESLint、`git diff --check` 通过。

完整页面补测命令：

```powershell
node --import tsx --test tests/agent/voc-review-page-integration.test.ts
node --import tsx --test --test-concurrency=1 tests/agent/analysis-project-favorites-ui.test.tsx tests/agent/project-delete-page.test.ts tests/agent/voc-review-browser.test.ts
npm run build
```

其余精确命令、原始根因和边界见同目录 `2026-09-10-voc-review-display-runtime.md`、`2026-09-10-three-asin-sync-gaps.md`、`2026-09-10-three-asin-cohort-recovery-preview.md`，以及 `docs/project-delete-restoration-20260910.md`。

后端组合测试仍显式排除了旧的 `analysis workspace and its sync funnel use the local Agent bridge` 源码字符串匹配测试；该断言在基线即不匹配现有 appSearch 写法。各窗口已记录基线全仓类型检查错误；vinext 构建成功不代表全仓 tsc 干净。

## 用户审查时需知的未完成事项

- **删除归属：** 26 个现有 analysis JSON 项目均无可信绑定，因此候选会拒绝删除它们；不能把恢复按钮称为恢复了现有项目的删除能力。需用户确认团队归属后，另行审查窄范围绑定方案，不能凭自由文本 createdBy 或同 ID 关联推定所有权。
- **正式旧任务：** 新组任务 `2f37a6e3-5ef0-4561-a6dd-359096876b72` v11 保持不变。只读预览证明可恢复已有成功流量、重分类四个阶段的缺口；尚未应用到正式 PG/镜像/数据产物。只合并代码不会自动纠正旧页面历史记录。
- **真实无主题：** luckystyle 投影有 70 条评论样本、0 个 Customers Say 主题，部分维度有结果；addlon 有 3 条样本、0 个 Customers Say 主题、六维无匹配。现有算法未产生主题不等于请求失败，也不证明真实顾客没有相应需求。
- **百分比：** 本次没有修改七维百分比归一化或四舍五入规则。
- **发布：** 待用户审查与剩余事项确认，不自动发布或操作真实数据。
