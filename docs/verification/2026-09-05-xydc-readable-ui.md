# 西柚变体模块可读性补丁验证

- 基线：`c7625d66a77bf918a27f28dd47e58c877f7f960b`。
- 补丁分支：`codex/fix-xydc-readable-ui-20260905`；独立 worktree，不改 live worktree。
- 改动：14px 正文、12px 辅助、72px 图片；摘要/内容 1:3 两栏；dimensions 入摘要；图文并排；明确且至少 36px 的查看全部按钮。手机上下排列。
- 不改：数据合同、Provider、缓存、父体/子体排序、状态、权限、VOC、历史记录、正式服务。

## 测试证据

1. 原 UI 基线 6/6 通过。
2. 测试先行 RED：新增浏览器测试发现原三列结构、8px 正文、44px 父图、24px 按钮；14 个统计测试中 5 失败（含父测试失败），9 通过。
3. GREEN：`node --test --import tsx tests/agent/xydc-variant-section.test.tsx` 14/14 通过；覆盖桌面 1440px（模块宽约 1100px）/手机 390px、真实 CSS/全局 preflight、预览、抽屉全数、排序与关闭。fixture 使用生产 `.compare-page > .card` 层级。拒绝外部请求和非 GET/HEAD 请求。
4. `node --test tests/rendered-html.test.mjs` 3/3 通过。
5. `npx eslint app/xydc-variant-section.tsx tests/agent/xydc-variant-section.test.tsx` exit 0。
6. `npm run build` exit 0；保留已有 chunk >500kB 提示，没有新增构建错误。
7. `git diff --check` 通过；LF/CRLF 提示不影响 diff 检查。

## 视觉与审查

- 已查看 `outputs/xydc-readable-ui/xydc-desktop.png`、`xydc-mobile.png`、`xydc-drawer.png`；图片来自独立测试数据，非正式业务数据。截图不进入 Git。
- 独立代码审查结论：可提交，没有本次 diff 阻断问题。CSS 未泄漏到其他模块，长子体属性可换行。
- 非阻断覆盖边界：未覆盖品牌名和维度标签为极长无空格连续字符串的情形；不作为当前小补丁扩展范围。
- 尚未合并或受控启动；正式页面仍为原版本，不能通过刷新看到此补丁。
