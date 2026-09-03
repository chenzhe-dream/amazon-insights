# 运营分析入口与 Sorftime 兜底设计

## 目标

在不影响当前稳定运行版本的前提下，把竞品分析入口收敛为运营可直接使用的工作流：历史项目不再挤满首页；3–10 个 ASIN 可一次粘贴并自动校验；SellerSprite 不可用时，Sorftime 能补齐其实际返回且经过严格校验的基础商品字段，使新 ASIN 主流程继续完成并明确展示剩余缺口。

## 稳定边界

- 当前稳定版本冻结；三个任务分别使用独立 worktree 和分支。
- 不删除或修改历史项目、既有任务、运行数据和生成数据。
- 不放宽租户、项目身份、并发、Provider readiness 或失败隔离门禁。
- 每个任务只做一次实现侧定向验证和一次独立限定复审；仅 Critical 或直接业务阻断允许返修。
- 三个任务合并后才允许一次受控部署和一次全新 3-ASIN 真实验收。

## 任务一：历史工作区收纳

### 行为

- 首页工作区条固定显示当前项目，并显示最近更新的 5 个其他项目。
- 其余项目进入默认折叠的“历史项目（N）”；展开后仍可正常切换。
- “项目收藏”页继续保留完整列表、搜索和编辑能力。
- 不增加删除、归档字段或数据库迁移；本切片只改变首页展示层。

### 验收

- 当前项目不会因更新时间较旧而被隐藏。
- 最近项目排序稳定，历史数量准确，折叠状态不会影响项目 URL 和数据。
- 0、1、5、6 个以上项目及当前项目不在最近列表等边界均有测试。

## 任务二：批量 ASIN 输入

### 行为

- 将概览页 10 个固定输入框替换为一个批量输入区。
- 支持换行、空格、中英文逗号、顿号、分号和竖线分隔；保持首次出现顺序。
- 自动转大写、去重，并显示“已识别 X/10 个”。
- 无效片段、重复项和超过 10 个的内容分别给出明确提示；不得静默截断。
- 只有 3–10 个唯一合法 ASIN 时允许开始分析；向后端仍提交现有有序 `string[]` 合同。
- 已保存项目加载后按同一格式回填；刷新与切换工作区不改变 ASIN 身份。

### 验收

- 粘贴三行、逗号混输、大小写重复、非法字符、少于 3 个和超过 10 个均有定向测试。
- 双击仍只产生一次业务提交；项目注册、URL owner 和 sync job 身份合同不变。

## 任务三：Sorftime 基础商品兜底

### 策略

- SellerSprite 可用且返回严格合法数据时仍为首选 catalog 来源。
- SellerSprite 不可用或该 ASIN catalog 缺失时，允许 Sorftime `product_detail` 及现有 Sorftime 模块生成“基础商品兜底”记录。
- 只投影 Sorftime 正式返回并由有界 schema 验证的字段；不接受任意对象或宽松透传。
- 字段级保留来源：SellerSprite、Sorftime 或 unavailable，不把 Sorftime 数据标成 SellerSprite。
- Sorftime 可覆盖范围包括实际合同存在的标题/品牌、主辅图与 A+、价格、评分与评论数、销量/价格/排名趋势、类目节点、FBA 和变体数据。
- LQS、视频/EBC badge、Buy Box 卖家及任何 Sorftime 未提供或未验证字段保持 unavailable。
- SIF 继续独立负责关键词和流量；本任务不得改变 SIF 解析器或流量语义。

### 流程语义

- SellerSprite 缺失不再阻断 Sorftime、SIF 和图片 AI 阶段。
- Sorftime 兜底满足基础页面所需字段时，该 ASIN catalog 标记为 `ready-with-fallback` 或等价的明确降级成功状态。
- 不可替代字段形成显式 gap；最终任务允许 `completed-with-gaps`，但不得显示为完整 SellerSprite 成功。
- 复用现有 Sorftime 调用结果或受控共享快照，避免为同一 ASIN 无界重复调用 `product_detail`。

### 验收

- SellerSprite unavailable + Sorftime ready 时，新 ASIN 页面仍可显示基础商品卡、图册和可用分析模块。
- SellerSprite 与 Sorftime 同时可用时，SellerSprite 优先且来源正确。
- Sorftime 缺字段、schema 非法或失败时 fail-closed，并只影响对应 ASIN/模块。
- 不新增 ASIN 特例，不伪造缺失字段，不改变 SIF/Sorftime 以外 Provider 行为。

## 集成与最终真实验收

三个任务分别提交并通过限定复审后，由主审核窗口按顺序集成，处理共享页面文件冲突并运行一次受影响测试集、一次生产构建和一次最终限定复审。受控部署后，使用三个从未提交的美国站 ASIN，只提交一次完整分析：要求一个 project/submission/job/run/stage 集合、单 Worker、页面可持续看到进度；最终逐 ASIN 核对基础商品、Sorftime、SIF、图册、图片 AI 备注及全部 gap reason。不得自动创建第二个真实任务。

## 非目标

- 不恢复或重写历史失败任务。
- 不实现数据库级手动归档、项目删除或批量清理。
- 不把 Sorftime 宣称为 SellerSprite 的完全替代。
- 不在本轮重构全部 Provider、生成数据架构或并发体系。
