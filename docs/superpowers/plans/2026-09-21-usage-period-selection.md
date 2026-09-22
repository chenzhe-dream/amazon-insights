# 使用统计指定周/月

用户已确认：周选择某一天，查询所属周（周一至周日）；月选择年月，查询自然月。初始为当前周/月，显示实际查询范围。

**范围**：只修改统计面板，复用 period + date 接口及北京时间后端计算。不改权限、采集、数据库或其他模块，不发布。

**实现**：
- 日、周、月独立保留选择值，初始按北京时间今天设置。
- 周使用 date 输入，月份使用 month 输入并传入该月 01 日；禁止未来日期/月及空值。
- 总览和个人明细均使用相同的所选日期；刷新保留选择。
- 周提示“所选日期所在周 · 周一至周日”；月提示“自然月”。查询返回的实际起止时间继续由现有标题展示。

**步骤**：
- [ ] 浏览器回归先复现周/月缺少输入：真实组件 + 隔离 Vite + 固定响应，验证请求中的 period/date。
- [ ] 修改 app/admin/users/usage-analytics-panel.tsx 的状态和输入框，不修改后端合同。
- [ ] 验证历史周、跨年周、闰月、独立选择保留、刷新、个人明细、错误恢复及 390px 布局。
- [ ] 运行现有统计单测、定向 lint 和类型检查，报告范围与限制。

**命令**：
```powershell
npx tsx tests/smoke/usage-period-selection.ts
npx tsx --test tests/agent/usage-analytics-query.test.ts tests/agent/usage-analytics-service.test.ts tests/agent/usage-analytics-contracts.test.ts tests/agent/usage-analytics-routes.test.ts
npx eslint app/admin/users/usage-analytics-panel.tsx tests/smoke/usage-period-selection.ts
npm run typecheck
```
