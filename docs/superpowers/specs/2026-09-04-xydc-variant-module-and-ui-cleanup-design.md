# 西柚变体模块替换与冗余入口清理设计

日期：2026-09-04  
状态：用户已批准规格，进入实施计划阶段

## 1. 目标

本变更包含三个隔离切片：

1. 将现有“变体评论结构与上架时间”模块替换为紧凑的“变体结构与商品页表现”模块，数据源改为西柚洞察 MCP。
2. 移除“VOC 独立分析”卡片和按钮，但保留 VOC 后端能力、已生成报告、历史记录及自动流水线中的 VOC 能力。
3. 移除“高级 A+”导航入口和独立页面，但保留底层 Listing/A+ 数据字段，避免影响其他报告和历史数据兼容。

三个切片必须独立提交和测试。西柚接入不得修改 Sorftime、SIF、SellerSprite、辅图 AI、管理员或共享历史的既有业务合同。

## 2. 已验证的数据能力

2026-09-04 已使用只读真实调用验证：

- MCP 服务可连接，服务名为 `xiyou-insight`。
- `get_asin_variations` 可从输入子 ASIN 识别父 ASIN，返回子 ASIN 列表、变体维度、每个子体的属性和值、数据更新时间。
- `get_asin_info` 可批量返回标题、价格、币种、评分、商品页当前评论数、主图和 Amazon 链接。
- 示例 `B0CNW5MX61` 识别到父体 `B0D7HRGMNP`、28 个子体和 `Color` 维度。

能力边界：

- 西柚不直接提供准确上架日期。
- `ratings` 仅定义为“商品页当前评论数”，不得解释为子体独立产生的评论数或评论占比。
- 当前工具不提供评论正文、辅图全集或 A+ 内容。
- 不使用首次观测时间推断上架日期。

## 3. 页面设计

### 3.1 模块边界

只替换现有模块所在区域，不修改页面导航、全局头部、其他数据模块或整页布局。

模块标题改为“变体结构与商品页表现”，右上角来源标识为“西柚洞察 MCP”。

### 3.2 默认紧凑状态

每个输入竞品占一行，展示：

- 竞品序号、主图、输入 ASIN；
- 父 ASIN；
- 子体数量；
- 颜色、尺寸等变体维度；
- 前三个子体预览：主图、属性、价格、评分、商品页当前评论数；
- 数据更新时间；
- “上架时间：数据源未提供”；
- “查看全部 N”按钮。

页面不得伪造父 ASIN、子体数量或演示数据。未查询或部分缺失的字段分别显示“待同步”或“数据源未提供”。
若多个输入 ASIN 属于同一父体，页面合并为一个父体分组，并在该行标记全部命中的输入 ASIN；不得重复展示同一变体家族。

### 3.3 全部子体详情

点击“查看全部 N”打开右侧抽屉，不扩张主页面高度。抽屉按分页或分批渲染全部子体，字段包括：

- 子 ASIN 与主图；
- 颜色、尺寸等属性；
- 价格与币种；
- 评分；
- 商品页当前评论数；
- 上架时间固定为“数据源未提供”；
- 数据更新时间或基础信息同步状态。

默认排序为商品页当前评论数降序；只允许切换价格和评分排序。上架时间不参与排序。

### 3.4 数据口径提示

模块底部固定显示：

> “商品页当前评论数”可能受亚马逊变体评论共享机制影响，不解释为该子体独立产生的评论数。

## 4. 系统设计

### 4.1 接入范围

西柚本期是“变体数据专用只读提供方”，不加入现有全局 `ConnectorId`、管理员凭据页面或通用并发配额合同，避免扩大对 SIF、Sorftime、SellerSprite 的改动面。

正式 Agent 从固定环境读取：

- `XYDC_MCP_URL`，默认 `https://mcp.xydc.com/mcp`；
- `XYDC_MCP_TOKEN`，必填且禁止写入前端、Git、快照、日志或错误正文。

### 4.2 客户端与数据合同

新增独立的西柚 MCP 客户端，只允许调用：

- `get_asin_variations`；
- `get_asin_info`。

内部标准化合同：

```text
XydcVariantFamily
  inputAsin
  country
  parentAsin
  dimensions[]
  children[]
    asin
    attributes[] { dimension, value }
    title?
    imageUrl?
    price?
    currency?
    stars?
    productPageRatings?
    listingDate = null
    infoStatus = ready | pending | unavailable
  sourceUpdatedAt?
  fetchedAt
  status = ready | partial | unavailable
  reasonCode?
```

所有西柚响应必须经过运行时 schema 校验。schema-invalid、超时和 HTTP/RPC 错误只能形成安全的状态码和脱敏原因，禁止把 Provider body 或 Token暴露给页面。

### 4.3 调用与缓存

- Provider 调用只发生在 Agent Worker 执行同步任务时，绝不发生在页面 GET、刷新或组件渲染期间。
- 每个输入 ASIN 调用一次 `get_asin_variations`。
- 根据返回的父 ASIN 合并重复家族；子 ASIN 全局去重后分批调用 `get_asin_info`，首版批大小为 20，可配置但不在 UI 暴露。
- 缓存按 `country + inputAsin` 存放在 `AGENT_DATA_ROOT/xydc-variants/`，不得写入代码工作树或生成 TypeScript 源文件。
- 同一 ASIN 的有效缓存默认 24 小时内复用。刷新页面不会产生 Provider 请求或积分消耗。
- 显式强制同步才忽略缓存；重试必须复用同一任务证据，不得因 Worker resume 重复扣费。
- 缓存写入使用原子临时文件替换，并沿用 Windows rename 重试策略。

### 4.4 流水线接入

西柚变体补充作为 `catalog` 完成后的可选 enrichment 执行，不增加新的顶层进度阶段：

- 已配置：执行西柚变体同步并记录 ready/partial/unavailable。
- 未配置：跳过 Provider，页面明确显示“西柚变体数据未配置”。
- 西柚失败：不得让基础 catalog、VOC、关键词、图片或其他模块失败；变体模块单独降级。

Worker 完成后，Web 端只通过现有 runtime analysis GET 读取 `AGENT_DATA_ROOT` 中与当前 ASIN 集合匹配的变体快照。任何项目或 ASIN 范围不匹配必须 fail-closed，不得串用其他项目缓存。

## 5. 空值和失败语义

- `ready`：变体关系和全部可查询的子体基础信息已返回。
- `partial`：父子关系可用，但部分子体的价格、评分、评论数或主图缺失；仍渲染可用字段。
- `unavailable`：未配置、鉴权失败、超时、响应非法或未找到变体；显示明确原因，不显示空白大卡片。
- 单一无变体商品：父 ASIN 可等于输入 ASIN，子体数量显示 1，并标记“单一商品/未发现其他变体”。
- 旧缓存：Provider 暂时失败时可以展示最后一次成功缓存，但必须显示原更新时间和“缓存数据”标记，不能伪装成本次同步成功。

## 6. 冗余入口清理

### 6.1 VOC 独立分析

只删除页面上的“VOC 独立分析”卡片、按钮及仅为该按钮服务的死代码。以下内容必须保留：

- Manual Alexa VOC 导入；
- 自动流水线中的 VOC 分析；
- VOC 报告查询与历史记录；
- 后端运行、恢复和状态接口。

### 6.2 高级 A+

删除侧栏/页签中的“高级 A+”入口及独立页面渲染分支。底层 Listing、A+、EBC、视频和 LQS 数据字段暂时保留，避免破坏旧快照、导出或其他消费者。

## 7. 测试与验收

### 7.1 自动测试

1. MCP 客户端：鉴权头、超时、RPC 错误、schema-invalid、Token 不泄露。
2. 标准化：父体、子体去重、属性映射、价格/评分/评论数字段、上架时间固定为空。
3. 批处理：超过 20 个子体分批；部分批次失败产生 partial；resume 不重复已成功批次。
4. 缓存：24 小时命中不调用 Provider；过期或强制同步才调用；原子写入失败保留旧缓存。
5. Runtime GET：只返回当前项目 ASIN 范围；刷新只 GET；无跨项目数据泄漏。
6. UI：三行紧凑展示、最多三个预览、抽屉展示全部、正确空态/partial/旧缓存标记、无伪造字段。
7. 清理回归：VOC 导入与自动 VOC 仍可用；旧 VOC 历史可读；A+底层数据合同仍可解析。
8. 全量门禁：build、受影响 Agent 测试、页面渲染测试、现有 GET-only smoke。

所有 Provider 测试使用编排级 fixture，不调用真实西柚、不消耗积分、不写正式业务数据。

### 7.2 人工验收

使用一个全新无缓存 ASIN 组：

1. 发起一次正常分析，确认 Worker 只调用一次变体关系并按批次补子体信息。
2. 页面出现父体、真实子体数量、属性、价格、评分、商品页当前评论数、主图和更新时间。
3. 上架时间显示“数据源未提供”。
4. 刷新页面，确认不产生新的 Provider 调用和积分消耗。
5. 点击“查看全部”，确认全部子体可浏览且主页面高度保持紧凑。
6. 模拟部分子体信息缺失，确认其余数据仍渲染且状态为 partial。
7. 确认“VOC 独立分析”和“高级 A+”入口消失，但自动 VOC、历史报告及其他分析模块不回归。

## 8. 实施切片和提交边界

1. `feat(xydc): add cached variant enrichment`：客户端、schema、缓存、Worker接入和 fixture 测试。
2. `feat(variants): render compact xiyou variant module`：runtime GET 合同、紧凑模块、抽屉和渲染测试。
3. `refactor(ui): remove redundant voc and a-plus entries`：只做两个 UI 入口清理及回归测试。
4. `test(xydc): add integrated regression coverage`：联合回归和最终门禁；若不需要额外代码，可不产生独立提交。

禁止在本变更中 push、部署、切换正式服务或运行真实业务 POST。正式 Provider 人工验收必须在实现、审查和候选构建全部通过后，由用户单独批准。
