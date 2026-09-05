# 西柚变体模块可读性 Implementation Plan

> **For agentic workers:** Use test-driven-development with a bounded test subtask and independent code review. Steps use checkbox syntax.

**Goal:** 放大变体模块可读内容，减少无效留白。

**Architecture:** 仅重排 XydcVariantSection JSX 和其专属 CSS。数据合同、预览数量、抽屉排序与请求路径不变。

**Tech Stack:** React, CSS Grid, Node test, Vite, Playwright.

## Global Constraints

- 正文 14px，辅助信息 12px；父/子图 64–80px。
- 桌面摘要/内容约 25%/75%，窄屏单列。
- 三项预览，按钮“查看全部 N 个子体”，至少 36px 高。
- 不改正式服务、Provider、数据、权限、历史、VOC 或其他模块。

## Task 1: 可读布局与覆盖真实 CSS 的浏览器回归

**Files:** `app/xydc-variant-section.tsx`, `app/comparison-layout.css`, `tests/agent/xydc-variant-section.test.tsx`.

**Interfaces:** 输入现有 products/families/market 不变；输出同一模块、同一抽屉。

- [x] 基线回归：`node --test --import tsx tests/agent/xydc-variant-section.test.tsx`，原 6/6 通过。
- [ ] RED：fixture 加载实际页面样式，断言 `parseFloat(getComputedStyle(card).fontSize) >= 14`、ASIN >= 12、图像 64–80、row 仅摘要/内容两列、按钮 >= 36、390px 不溢出。
- [ ] GREEN：移动 dimensions 容器至 summary 内；按钮改为 `查看全部 {group.children.length} 个子体`；将独立 xydc CSS 块改为 `grid-template-columns: minmax(0,1fr) minmax(0,3fr)`，并实现上述字号/尺寸/窄屏覆盖。
- [ ] 验证：重跑 UI 测试、`npx eslint app/xydc-variant-section.tsx tests/agent/xydc-variant-section.test.tsx`、`npm run build`。build 只在补丁 worktree，禁用对外遥测，不接正式数据库。
- [ ] 查看独立 fixture 的桌面与手机截图，确认排版没有裁剪。
- [ ] 独立审查（规格与质量），修复本任务问题。
- [ ] `git diff --check`；仅提交本任务文件并报告 commit，正式更新留待受控启动授权。
