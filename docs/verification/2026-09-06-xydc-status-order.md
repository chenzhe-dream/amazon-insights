# 西柚展示状态与顺序补丁验证

## 版本与范围

- 基线：`1eb1d4e9719a0a2f0951f687a61d6716e4cf86bc`。
- 分支：`codex/fix-xydc-status-order-20260906`。
- 代码提交：`939a4cc3e4fb8c41adde1a34201e9dca7dece41c`。
- 仅修改 `app/xydc-variant-section.tsx` 及对应 UI 测试；CSS 无需修改。另包含已批准设计、实施计划与验证文档。
- 不修改采集、缓存、共享合同、数据库、权限、VOC、历史记录或 `app/page.tsx`。没有推送、合并、部署或重启正式服务。

## 本次新跑的验证

1. 旧 UI 基线 14/14。
2. RED：17 个统计测试，12 通过、5 失败；旧代码缺少变体状态说明、显示目录占位，代表商品/命中顺序错误，原因和子体状态英文，抽屉将采集时间当作来源更新时间。均为实际断言失败，不是测试环境错误。
3. GREEN 与主审核复跑：`node --test --import tsx tests/agent/xydc-variant-section.test.tsx`，18/18；含不同竞品父体逆序与共享父体代表商品、目录空值/占位和真实品牌保留、中文原因、独立来源/采集时间、真实 CSS 的字号及桌面/手机/抽屉回归。fixture 阻止外部请求及非 GET/HEAD 请求。
4. `node --conditions=react-server --test --import tsx tests/agent/runtime-analysis-data.test.ts`，10/10；包括鉴权失败、ASIN/站点隔离、旧 payload 与西柚缓存读取。首次误用无 react-server 条件的命令触发 server-only 导入保护；使用仓库规定的运行条件后通过，没有改业务代码绕过保护。
5. 新构建后 `node --test tests/rendered-html.test.mjs`，3/3；认证检查壳和原有入口保留规则通过。上述主审核定向检查共 31 项，不代表全库测试。
6. 定向 ESLint exit 0，`git diff --check` exit 0。Git LF/CRLF 提示为换行转换提示。
7. `npm run build` exit 0；保留已有 chunk >500kB 提示。`dist/build-fingerprint.json` 与当前源码一致。

## 视觉与审查

- 已检查独立测试数据的桌面、手机和抽屉截图：`outputs/xydc-status-order-20260906/xydc-desktop.png`、`xydc-mobile.png`、`xydc-drawer.png`。未控制用户 Chrome，图片不是正式商品数据。
- 状态文字至少 14px，辅助说明至少 12px，72px 缩略图、三子体预览及窄屏堆叠保持。
- 时间保留原始字符串及明确来源标签；未转换时区，上架日期仍为“数据源未提供”。
- 独立规格/质量审查：Spec compliant / Approved；独立整分支审查：Ready to merge Yes。均无 Critical / Important。
- 非阻断建议：可另补“多个未匹配组排在已匹配组后，并按 country:parentAsin 排序”的显式测试；排序实现已由两次代码审查核对，本轮未扩展此测试组合。

## 发布边界

本轮交付为补丁分支，没有切换正式服务。正式用户不会仅通过刷新看到本次改动；需另行受控合并更新，更新前再次检查运行身份、活动任务、共享数据根与构建。无需重新采集数据。
