# 页面代码与业务模块导航

这个目录同时包含页面路由、交互组件和部分历史生成数据。查找功能时，先按下表定位入口；不要把所有 `app/` 文件都当成页面，也不要把这里的 API 路由视为完整后端实现。

## 页面与模块边界

```text
app/page.tsx                  路由入口与认证边界
app/p/[slug]/                 项目工作区路由
app/admin/                    管理页面
app/features/shell/           导航定义、分组、图标与导航文字展示
app/features/projects/        项目列表、收藏、历史切换与历史任务读取
app/features/sync/            ASIN输入、同步进度与阶段缺口提示
app/features/voc/             VOC录入、教程、状态、展示与定位
app/features/keywords/        关键词分类、需求分析、术语和采集状态
app/features/traffic/         流量结论、采集状态和详情补取
app/features/listing/         商品图片、图片解读和A+展示
app/features/product-reports/ 产品定义、立项建议、确认清单和导出
app/features/workspace/       工作区控制逻辑与页签装配
app/features/catalog/         商品展示合同与概览页签
app/features/charts/          销售趋势图与通用时间轴格式
app/components/               跨业务复用的评分、表格、步骤和堆叠条展示
app/api/                      Web 侧接口与后端代理
app/lib/                      现有浏览器客户端和页面辅助逻辑
```

`features/shell/` 负责导航结构与展示，不持有采集任务、VOC 输入或数据库状态。`components/` 只收纳实际跨业务复用的组件，不作为新的杂物目录。主页面通过显式参数使用它们；它们不能反向导入 `page.tsx`。

## 按业务找代码

| 业务 | 当前前端入口 | 服务端或脚本入口 |
| --- | --- | --- |
| 项目、收藏和历史工作区 | `features/projects/project-library-panel.tsx`、`features/projects/workspace-history-strip.tsx`、`features/projects/use-analysis-project-favorites.ts` | `server/routes/` 下项目接口、`server/services/` 中对应服务 |
| ASIN采集、进度与补抓 | `features/sync/batch-asin-input.tsx`、`features/sync/asin-sync-funnel.tsx`、`lib/sync-incomplete-repair-browser.ts` | `scripts/run-asin-sync-job.mjs`、`scripts/lib/` 中就绪判断/缓存/阶段存储、`server/services/` 中同步服务 |
| 手工VOC录入 | `features/voc/alexa-voc-import-panel.tsx`、`features/voc/use-manual-alexa-voc.ts` | `server/routes/manual-alexa-voc.ts`、`server/services/manual-alexa-voc-service.ts`、标准化 worker |
| VOC来源与新品定义 | `features/voc/voc-evidence-definition.tsx`、`features/product-reports/product-definition-section.tsx`、`lib/voc-evidence-browser.ts` | `server/services/voc-evidence-inventory-service.ts`、`analysis-run-service.ts`、VOC/产品定义 execution service |
| VOC展示与定位 | `features/voc/voc-development-summary.ts`、`features/voc/voc-positioning-section.tsx` | `server/domain/voc/`、`server/runtime/` 中VOC运行逻辑 |
| 关键词与流量 | `features/keywords/keyword-demand-section.tsx`、`features/keywords/keyword-demand-analysis.ts`、`features/traffic/traffic-detail-recovery.tsx`、`lib/traffic-*` | `server/domain/traffic/`、SIF采集脚本 |
| Listing与图片 | `features/listing/listing-images-section.tsx`、`features/listing/listing-aplus-section.tsx` | `scripts/build-sorftime-listing-content.mjs`、`scripts/build-listing-image-remarks.mjs` |
| 产品报告与立项清单 | `features/product-reports/product-launch-analysis.ts`、`features/product-reports/launch-checklist-section.tsx`、`features/product-reports/launch-checklist-export.ts` | `server/domain/`、报告执行服务 |
| 持久报告与历史结果 | `lib/saved-analysis-reports.ts`、各报告展示组件 | `server/db/` 中报告存储、`server/services/` 中执行与发布服务 |

业务页签已放入各自模块的 `*-tab.tsx` / `*-tabs.tsx`，由 `features/workspace/workspace-view.tsx` 按原页签条件装配。认证入口调用工作区 controller，再把数据和事件交给视图。项目历史读取入口为 `features/projects/historical-sync-pointer.ts`。共享客户端、服务端与生成数据仍在原有位置。控制层内部仍在按会话、运行数据、历史恢复和同步职责继续拆分；薄入口并不代表内部架构已经全部完成。

## 数据、接口与服务端

- `*-data.ts`、部分 `*-raw-data.ts` 与 `listing-image-remarks.ts` 包含脚本生成或发布的数据投影。移动前必须核对生成脚本、缓存读取和构建发布路径，不能作为普通组件直接移动。
- `app/api/` 提供 Web 侧接口与代理；独立后端从 `server/index.ts` 启动，经 `server/agent-service.ts` 装配。业务代码按 routes → services/domain → db/connectors 分层。
- 浏览器组件只使用允许的浏览器客户端和显式 props，不导入数据库实现、Node文件系统或凭据。
- `shared/` 保存前后端共享合同；`server/db/migrations/` 管理数据库结构变更；`skills-src/` 保存分析技能与版本声明。
- 正式缓存和运行状态有独立运行根配置；Git源码提交不等于数据库/缓存备份。不要通过移动或清理开发目录来清除正式业务数据。

## 新增代码的归属原则

1. 同一业务一起变化的展示和辅助逻辑应靠近放置；抽取前先核对调用者。
2. 路由文件保留路由与装配职责，复杂业务规则放入对应模块。
3. 共享组件只接收展示所需输入；采集、副作用和权限检查归属明确的业务服务。
4. 每批迁移保持现有行为，独立验证和提交；结构调整与功能变更分开记录。
