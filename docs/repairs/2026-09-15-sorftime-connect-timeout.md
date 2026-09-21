# 四个滑板车 ASIN 的 Sorftime 连接失败

范围：B0DZFGTCLR、B0CTJGJL2T、B0CDRDK6MR、B0GWDV1FL5。
项目：4984aadc-4713-45f6-ad1a-1dc1d5235ee7，/p/project-us-14。

## 原因及数据现状

- 最初任务 72df6c81-8735-4c5e-af53-97592b215757 于北京时间 13:42 发起。镜像 diagnostics 记录 B0CDRDK6MR reviews CONNECT_TIMEOUT；另外三个 reviews 是 PROVIDER_DEGRADED，未实际请求。
- Sorftime 连接失败一次即触发任务内保护，后续多个阶段被跳过，展示为连接失败。原先只有 category 有一次连接超时重试，reviews 没有。
- 页面评论提示用整个阶段的 reasonCode 标记所有缺失 ASIN，导致把连接失败一起显示成超时。
- 当前 DNS、HTTPS 连通性正常；使用正式环境配置的 Sorftime 凭据执行 tools/list 成功，返回 105 个工具。本次未输出任何凭据。
- 后续已有补抓任务 a5d49081-b461-463f-965c-29031fd10c4c 于 14:00:37 完成，其 10 个持久化模块输出全部 done，四个 ASIN 自动模块全部 ready。该补抓非本次诊断发起，不重复执行。
- 最新 run f8f7eba3-00d4-4c20-b1da-7e7fb1cc2e81 已是项目 current_run_id。原始失败记录保留，未将失败历史改写为成功。

## 修正

- 所有 Sorftime 连接超时均可进行一次受资源限额管理的重试；最大两次请求。已有 transient-retry、取消信号和过期预算不再重试；其他错误不扩大重试。
- 重试恢复成功时不触发整个任务的保护。连续失败仍保留保护，防止无休止请求。
- 评论/FBA 提示按持久化 gap.items 展示各 ASIN 的原因；保护跳过的模块记录明确原因。

## 验证与发布

- 15 项连接器/诊断测试、10 项缺口提示测试、25 项阶段后置条件测试通过；全仓类型检查通过。
- 正式发布曾被 manage-formal-stack 拒绝，因为 VOC 定位任务 d1a678fe-29a2-4bde-b648-f8d934ef9ae3 仍在运行。未终止该任务或绕过发布检查。
- 最新数据入口：/p/project-us-14?run=f8f7eba3-00d4-4c20-b1da-7e7fb1cc2e81&syncJob=a5d49081-b461-463f-965c-29031fd10c4c。
- 后续 VOC 任务自行结束，活动计数回到 0；已通过正式管理脚本完成受控发布。Web/Agent 均健康且源码版本一致：e55b999e877eac10f202a7d3c33435f9fcfc917ac504b2c5711dc549ea0fb5aa。构建及 50 项相关测试通过。
