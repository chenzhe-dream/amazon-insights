# 第一批模块整理验证

## 范围与基线

- 基于完整发布的 VOC + 补抓版本 `5ba042f`，执行计划起点为文档提交 `e013858`。
- 本批只整理导航定义/分组/图标和跨业务评分展示，保留主页面业务状态、路由副作用、VOC与采集流程。
- `app/README.md` 提供实际模块入口导航；projects/sync/VOC/keywords/listing/reports 的整体物理目录迁移属于后续工作。
- 正式服务保持 `5ba042f`，本批不再次发布，也不推送 GitHub。

## 既有检查边界

- 发布前基线生产构建通过。
- 主页面浏览器终态刷新测试期待一次请求，实际为两次；正式 `1551ed0` 的隔离源码副本及合并版本 `5ba042f` 都复现同一失败。不得删改该断言来获得全绿。
- 项目已有 TypeScript、page lint 和技能ZIP一致性问题；本批检查重点是新增错误和受影响行为，不宣称全仓无历史问题。

## 实施与最终检查

- 源码提交：`d3e28fe`。主页面从 4184 行降至 3912 行（按非尾部空行计数，减少 272 行）。新增 navigation.ts、navigation-presentation.tsx、amazon-star-rating.tsx 三个模块，以及两份行为测试。
- 复核过程中发现并在提交前补回 NavGroupId 类型导入和 savedReportStageLabels 常量。其余业务状态、副作用、历史报告与数据接线未改变。
- `npx --no-install tsx --test tests/agent/app-tabs.test.ts tests/agent/shell-navigation.test.ts tests/agent/amazon-star-rating.test.tsx`：5/5。
- `node --test tests/rendered-html.test.mjs`：3/3。
- `npx --no-install tsx --test --test-name-pattern="sidebar" tests/agent/traffic-display-regression.test.tsx`：5/5，覆盖 1280/1920 桌面、矮桌面菜单滚动与弹层，以及 390/760 移动布局。
- `npx --no-install tsx --test tests/agent/voc-keyword-evidence-browser.test.ts tests/agent/product-definition-section.test.tsx tests/agent/primary-admin-browser.test.ts`：24/25，唯一失败与上文基线相同。未删除或弱化既有断言。
- 新模块与新增测试的 ESLint 通过；最终 `npm run build` 通过，保留既有大块体积/路由分类提示。
- 使用项目 TypeScript 配置，以 page、新模块及 next-env 为入口检查实际依赖图，并以 e013858 原 page 覆盖作为对照：基线 23 个、当前 23 个诊断，按文件/错误码/消息比较新增为零。该检查不是全仓 tsc 全绿。
- `git diff --check` 通过。源码变更未再次发布，正式保持 VOC 完整版本 5ba042f。
- 独立审查结论由收尾记录补充。
