# Git 源码交接基线

本次按用户要求将 integration 工作区积累的功能源码、数据库迁移、测试、OpenSpec 与修复文档提交到现有 GitHub 仓库的当前分支 `codex/integrate-xydc-variant-20260905`，供 Cursor 继续定位 Bug。不是合并 main，也不重新发布正式服务。

范围包括市场调研四模块、VOC 与产品定义证据规则、连接复用与重试、用户模块可见性和默认值、反馈提出人和附件展示、竞品全屏、颜色呈现、七维格式说明收起展开等当前工作区实现。不同功能此前的验收记录见各 OpenSpec 和修复文档；本次保存源码不代表对全部历史改动重新完成业务验收。

工作区还有十五份已跟踪的生成数据文件（竞品 catalog、图片分析结果、SIF 和 Sorftime 数据快照）以及 TypeScript 构建缓存。本次保留在本地，不将其运行期间的数据变化混入源码提交。Git 可能因此仍显示这些文件为 modified；这与功能源码未提交不同。不要通过 reset/clean 删除这些数据。

`.superpowers` 本地调查产物、`test-results` 测试输出以及根目录 market skill 导出 zip 新增忽略规则；原有已跟踪内容不受忽略规则影响。正式配置和数据库位于外部 runtime 目录，不进入本次提交。

交接时优先读取当前分支和本文件，再结合 README、openspec/specs、openspec/changes、docs/market-research、docs/repairs 与实际源码。正式部署具有自己的 artifact/sourceCommit/sourceHash；Git 提交更新不会自动重启正式服务。

提交前验证：`npm run typecheck` 通过；反馈接口 8 项、MCP 会话池 10 项、反馈界面与颜色映射 11 项，共 29 项定向测试通过。本次未重新运行完整测试集，也未重新进行全模块业务验收。
