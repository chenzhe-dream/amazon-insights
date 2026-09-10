# 固定侧栏与新 ASIN 验收材料

## 范围与根因

`app/globals.css` 中桌面 `.nav-rail` 由普通 relative 恢复为 sticky，显式顶对齐并使用动态视口高度。grid 继续保留导航占位；导航内容太长时仅菜单滚动，品牌和底部帮助不收缩。760px 以下仍使用顶部横向导航。`app/page.tsx` 的菜单底边钳制增加 top 依赖，修复同组重复定位时越界。

未更改流量/VOC/权限/缓存业务链路；未自动写入测试 VOC，未调用新 ASIN 的采集服务。

## 自动验证

- 红灯：原 CSS 下桌面 1280/1920px 滚动 900px 后侧栏 y=-900；600px 高度菜单没有内部滚动。3 失败、2 移动布局通过。
- 绿灯：5 项浏览器专项全部通过，覆盖固定位置、正文不被遮挡、帮助可见、菜单尾项、三级菜单可点击性和 Escape、390/760px 布局。
- 只读审核发现并复现矮窗口主组 hover→click 固定后的浮层越界：视口 600px，底边 617.67px；新增主组真实 click 断言。增加 `flyoutTop` 依赖后绿灯，钳制再次生效。
- 三级菜单沿用原导航代码，隔离夹具用 trial click 检查稳定/可接收点击及 href。夹具不是 Next 路由服务器，不能用链接硬导航验证路由加载，未将其误报为线上导航故障。
- `npm run test:traffic-regression` 全部通过（日志：`test-results/sidebar-traffic-regression.log`）。
- 三份测试 VOC 通过原七维解析器：ASIN 唯一绑定、七维非空、每维至少两点、每条带“模拟”，评分和评论数为空。
- `npm run build` 成功（`test-results/sidebar-build.log`），`git diff --check` 通过。

## 三组新样例

Amazon US 商品页确认：Nukanu `B0CP8Q2JCS`、Govee `B0F43M9KWW`、O’Bright Ray `B0BDD936ZC`。只读检查时：28 个现有项目 JSON 均无这三个 ASIN；PostgreSQL VOC 修订中分别 0 条。

`docs/testing/2026-09-10-lamp-voc/` 的三个 txt 为明确标注的虚构验收文本，不是 Alexa 回复或真实买家反馈，不可用于实际市场结论。

## 发布保护

发布前队列 active=0；本机、LAN、agent 健康。备份目录：`C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/sidebar-layout-20260910-103135`，118 个受保护文件含 15 个正式生成文件、28 个项目、配置、运行状态、旧制品，以及 PostgreSQL dump。PG 监听 PID 51004。

保留全部并行 WIP；仅提交本次 CSS、回归、模拟文本与本次文档。正式发布后核对版本指针、健康与受保护文件/数据库指纹，结果待追加。
