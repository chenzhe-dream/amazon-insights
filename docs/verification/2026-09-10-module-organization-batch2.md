# 第二批：项目与同步模块整理

## 交付

- 基线 `8edb259`；源码提交 `ccbceee`。用户授权继续分批整理；仅本地 Git，不推送 GitHub、不再次发布。
- 四个项目管理文件移入 `app/features/projects/`：项目列表、收藏 hook、收藏按钮、历史切换条。
- 四个同步界面文件移入 `app/features/sync/`：批量 ASIN 输入、同步进度漏斗、阶段缺口卡片、缺口提示。
- `readHistoricalSyncPointer` 从主页面移入项目模块，保留 project → run → job 三次只读请求、全部身份/ASIN/marketplace校验以及错误返回 null 的语义。
- 同步已有导入者、测试导入与一个测试的源码读取路径；没有保留旧路径转发壳。公共浏览器客户端仍在 app/lib，后端/数据库/生成数据/CSS/URL行为不变。
- 对8个迁移文件作导入目标归一比对，8/8除路径外正文一致。helper原函数正文也与8edb259精确一致，仅新增模块 imports/export。

## 验证

- 项目收藏界面、历史切换、ASIN输入、缺口展示与补抓可用性：33/33。
- 收藏后端：9/9。首次将服务端测试混入普通 React 条件导致 server-only 拒绝加载；按现有约定单独用 `--conditions=react-server` 运行通过，未修改产品代码来规避。
- 历史指针 helper：34/34，全部 mocked fetch，覆盖成功、缺失、身份/范围错误以及各层HTTP/JSON/网络失败。
- 项目删除完整页面：1/1，删除后迟到响应和存储不能恢复旧工作区。
- 同步会话 terminal/repair/scope 相关浏览器与逻辑：28/28。运行期间页面接入helper触发一次开发HMR，收尾另在稳定源码上运行历史工作区恢复及跨run拒绝2/2。
- `npm run build`：通过。最终渲染测试3/3。
- 项目/同步模块及新增测试 ESLint：通过。
- 依赖图 TypeScript 对比：用当前项目配置，以page/next-env为入口，基线虚拟加载8edb259原文件与旧路径，当前使用新目录；按重命名归一的文件/错误码/消息比较，基线24、当前24、新增0。这不是全仓tsc通过声明。
- 原有主页面终态数据刷新2-vs-1失败与全仓债务记录仍保留；本批没有改相关断言或声称解决。
- 正式健康检查仍为ok、版本5ba042f；所有验证使用本地临时fixture，不启动真实采集。

## 审查与收尾

独立整批审查发现并关闭一项 P2：`tsconfig.stage-results-category-retry.json` 显式入口仍用旧同步文件路径。已更新到新路径，复审 Ready，无其余确认的 P1/P2。该配置34个入口文件全部存在，定向运行不再出现 TS6053。主页面从3912行降为3865行。模块入口见 `app/README.md`；VOC、关键词、Listing与报告前端尚待后续按业务归拢。

定向配置补充检查：`tsc --project tsconfig.stage-results-category-retry.json` 仍报告95个类型诊断。使用同配置、完整恢复重命名前虚拟源码及入口的对照为96个，当前95个，按文件/错误码/消息比较新增0；不宣称该定向检查全绿。
