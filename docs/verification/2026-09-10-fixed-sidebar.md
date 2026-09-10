# 固定侧栏与新 ASIN 验收材料

## 范围与根因

`app/globals.css` 中桌面 `.nav-rail` 由普通 relative 恢复为 sticky，显式顶对齐并使用动态视口高度。grid 继续保留导航占位；导航内容太长时仅菜单滚动，品牌和底部帮助不收缩。760px 以下仍使用顶部横向导航。`app/page.tsx` 的菜单底边钳制增加 top 依赖，修复同组重复定位时越界。

未更改流量/VOC/权限/缓存业务链路；未自动写入测试 VOC，未调用新 ASIN 的采集服务。

## 自动验证

- 红灯：原 CSS 下桌面 1280/1920px 滚动 900px 后侧栏 y=-900；600px 高度菜单没有内部滚动。3 失败、2 移动布局通过。
- 绿灯：5 项浏览器专项全部通过，覆盖固定位置、正文不被遮挡、帮助可见、菜单尾项、三级菜单可点击性和 Escape、390/760px 布局。
- 只读审核发现并复现矮窗口主组 hover→click 固定后的浮层越界：视口 600px，底边 617.67px；新增主组真实 click 断言。增加 `flyoutTop` 依赖后绿灯，钳制再次生效。
- 三级菜单沿用原导航代码，隔离夹具用 trial click 检查稳定/可接收点击及 href。夹具不是 Next 路由服务器，不能用链接硬导航验证路由加载，未将其误报为线上导航故障。
- `npm run test:traffic-regression` 最终重跑全部通过，36 个脚本测试 + 62 个服务/页面回归（日志：`test-results/sidebar-traffic-regression.log`）。加三份 VOC 解析共 101 项相关测试通过。
- 三份测试 VOC 通过原七维解析器：ASIN 唯一绑定、七维非空、每维至少两点、每条带“模拟”，评分和评论数为空。
- `npm run build` 成功（`test-results/sidebar-build.log`），`git diff --check` 通过。

## 三组新样例

Amazon US 商品页确认：Nukanu `B0CP8Q2JCS`、Govee `B0F43M9KWW`、O’Bright Ray `B0BDD936ZC`。只读检查时：28 个现有项目 JSON 均无这三个 ASIN；PostgreSQL VOC 修订中分别 0 条。

`docs/testing/2026-09-10-lamp-voc/` 的三个 txt 为明确标注的虚构验收文本，不是 Alexa 回复或真实买家反馈，不可用于实际市场结论。

## 发布保护

发布前队列 active=0；本机、LAN、agent 健康。备份目录：`C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/sidebar-layout-20260910-103135`，118 个受保护文件含 15 个正式生成文件、28 个项目、配置、运行状态、旧制品，以及 PostgreSQL dump。PG 监听 PID 51004。

保留全部并行 WIP；仅提交本次 CSS、菜单定位一行依赖修正、回归、模拟文本与本次文档。独立只读审核通过后受控发布完成：

- 正式代码：`da3587aba55e73a93ace85a238533a42627769b2`。
- sourceHash：`3152551cddffcfee00c393096f2bc6ad77e231d42c7129e5b920e02a9ca8c6fc`。
- 新制品：`f096668f640d7242733d3ae307e977e929d16dfd8acba395d7d7b85cf1b5d8dc`；保留旧制品 `3eeb2165fe3374213d9d83f2ff47d344a4ccb6efea9aac439068b50df03c0e5d`。
- 本机/LAN Web 与 Agent 三个健康端点均为 ok，代码版本一致。
- 从正式 HTTP 返回的 CSS 检出 sticky 定位和菜单内部滚动规则。
- 44 个生成文件/项目/正式配置逐个 SHA256 未变，dataCurrent 指针未变。
- PostgreSQL 受保护的历史快照、stage output、job、全部 VOC heads/revisions 内容指纹未变。

本次不替用户发起新 ASIN 分析、VOC 提交或付费数据采集，实际第三方覆盖与标准化效果留给独立测试项目验收。
