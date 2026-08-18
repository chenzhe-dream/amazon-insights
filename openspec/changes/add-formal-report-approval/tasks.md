## 1. Approval Contract

- [ ] 1.1 定义报告审批身份、状态、动作、原因代码和不可变事件 schema
- [ ] 1.2 定义提交者、审核人、撤销人和职责分离权限矩阵
- [ ] 1.3 定义审批与人工评分、智能体 release decision、产品立项之间的语义边界

## 2. Persistence and Service

- [ ] 2.1 实现按 reportId/version/contentDigest 原子校验的审批事件仓储
- [ ] 2.2 实现闭合状态转换、幂等、并发冲突和 fail-closed 读取服务
- [ ] 2.3 实现新报告版本对旧 pending/approved 状态的 superseded 处理

## 3. Product Surface and Verification

- [ ] 3.1 实现受角色控制的审批 API、待办视图和完整审计查看
- [ ] 3.2 让页面与导出明确区分 analysis-result、正式报告批准和产品立项
- [ ] 3.3 验证跨组织、错版本、错摘要、自审、竞态、撤销和损坏审计场景
- [ ] 3.4 在独立发布 change 批准前保持正式审批功能关闭
