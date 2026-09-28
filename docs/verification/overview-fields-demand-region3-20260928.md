# 模块一字段与行业需求趋势（区域3）验收

## 范围

- 用户已确认前一区域，通过后继续按既定顺序补齐 A4、A5；不包含下一步 A3 总结规则或 A6 外部商品需求空响应。
- 对照原版 `sellersprite-market-query.ts` 的 mapNiche、类目词筛选、keyword_research 补词、ABA 月度 searches，以及原版三张 KPI 卡片。
- 原业务流程沿用；新总览版本 rules-v3 增加自己的行业趋势步骤，不读取模块三任务。旧规则版本与历史报告继续可读。

## 结果

- 已保存来源中24项原版字段重新映射，涵盖 BSR、重量体积、毛利、头部均值、新品数及上架日期等，保留原单位与 frozen headTopN/newProductMonths；不改写旧报告或语义输入。
- 行业关键词按原版取最多5词、最多48个月；来源响应按本次类目/站点/词绑定保存，原始空响应、失败、缺月、零值分别保留。
- 基础报告先保存；部分趋势失败时保留成功结果。原生限流、超时、临时故障自动重试保留 partial 快照，手动重试不回写历史。
- 行业趋势图220px、月份悬停/键盘查看，缺月断线；旧报告明确说明未采集，GET不会触发补采。任务步骤显示“采集行业关键词趋势”。

## 验证

- 最终后端回归67项通过：新旧流程、真实独立 PostgreSQL、手动/自动重试、只读重放、历史冻结、取消、公共入口、一般失败禁止写快照。
- 字段、图形与趋势展示10项通过。独立复核之前2处P2已修复，无新增P1/P2。
- 桌面浏览器检查实际旧报告来源字段和隔离数据库生成的趋势快照：正常、部分失败、失败、历史未采集四种状态；0页面错误。未把隔离connector数据描述为真实供应商返回。
- 真实冻结8月样本投影：平均BSR 5,820，头部BSR 754，新品11，头部均月销10,664.2；真实月来源对照可回放。
- 有1项现存旧语义分析完整链路测试失败：market-overview-complete-flow.test.ts 第54行窗口为partial而预期complete。独立未修改基线cd5d0dda同样失败；诊断159项窗口拒绝、0已生成窗口。保留原断言与实现，未以弱化断言掩盖；该路径非本次rules-v3运行路径，另行排查。

## 发布

待填：正式版本、制品、线上只读验收。线上验收必须核对旧报告哈希、步骤数不变；新增真实供应商趋势仍需新建/重新采集总览验证。

## 证据

本地忽略目录 test-results：overview-fields-regression-final.log、overview-fields-ui-tests.log、overview-fields-typecheck-final.log、overview-fields-demand-browser/*、overview-demand-integration/{partial,complete}.json、overview-complete-baseline.log。
