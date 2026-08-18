## 1. Experiment Contract

- [ ] 1.1 冻结静态编排与 LangGraph 共用的输入、Skill、provider、时钟和失败 fixture
- [ ] 1.2 定义规范化状态轨迹、结果、恢复、调用、Token、费用、延迟和写入度量
- [ ] 1.3 定义 adopt、do-not-adopt 和 needs-more-evidence 的证据门槛

## 2. Isolated Prototype

- [ ] 2.1 在不被生产入口导入的隔离目录实现 LangGraph 等价依赖图
- [ ] 2.2 使用临时检查点存储实现节点边界崩溃与恢复实验
- [ ] 2.3 运行成功、waiting-input、失败、预算、取消、重复和乱序矩阵

## 3. Comparison and Decision

- [ ] 3.1 对静态编排与 LangGraph 重复运行同一 fixture 并保存规范化差异
- [ ] 3.2 汇总确定性、恢复、可观察性、复杂度和完整成本账本
- [ ] 3.3 发布带版本与 fixture digest 的实验报告和采用建议
- [ ] 3.4 在后续 adoption change 批准前确认生产构建与运行路径不包含 LangGraph
