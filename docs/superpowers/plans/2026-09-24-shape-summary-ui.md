# 商品形态报告三处摘要 UI 修复

用户已确认按三处布局方案修复，继续本地测试和正式页面验收。

目标：保留原业务流程和所有分析函数，只整理毛利准入、上架年龄和综合结论的信息层级。

- [x] 毛利区：使用现有 tiers 和平均值显示指标与标签，去除重复统计文案；保留建议、费用口径和缺失说明。缺失占比与有效样本占比分别标明分母。
- [x] 上架年龄：市场判断和建议置顶，显示样本与核心指标，依据和风险分栏；移除与标题、指标重复的摘要。
- [x] 综合区：六项概况用指标卡展示；依据 synthesis 状态显示“规则结论已生成”或“综合结论待补数据”；数据缺口独立呈现，保留来源口径。
- [x] 运行现有规则一致性、视图测试和类型检查；补测成功/缺失状态与毛利缺失分母，不改分析器。
- [ ] 用已保存真实报告检查桌面和窄屏，正式基线未漂移且任务空闲后发布，刷新正式报告核对。

修改文件：app/market-shape-reference/conclusions/view.tsx、app/market-shape-reference/view.tsx、app/market-ui-reference.css、tests/agent/market-shape-reference-view.test.tsx。
测试：node --import tsx --test tests/agent/market-shape-reference-conclusions.test.ts tests/agent/market-shape-reference-view.test.tsx tests/agent/market-shape-reference-rules.test.ts；npm run typecheck。
回滚：撤销本次提交并通过受管发布脚本发布，不更改数据库。

