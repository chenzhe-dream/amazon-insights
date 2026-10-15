# 评论和关键词剩余缺口核查与修复

范围：32900 候选；不调用真实供应商，不发布31900。

## 真实证据与原因

关键词任务 `360a350e-0d52-4758-9ab4-2af79592933a` 的100个趋势步骤均已终态：89成功、11 empty、0失败。empty表示研究月没有搜索量，而非整个来源没有历史。

| 缺研究月但已有历史的词 | 已保存月份数 |
| --- | --- |
| floor lamp- | 2 |
| warm light floor lamp | 3 |
| room lamp standing | 10 |
| lamps standing | 1 |
| floor lamps living room | 6 |
| U+FFFC字符开头的 floor lamp | 1 |

另5个词搜索量历史完全为空：floor laml、bedroom lamp floor、floor lmap、big floor lamp、fllor lamp。检索候选库同站点同词全部保存来源，没有找到可补回的研究月数据；错拼词保持原词，不冒充标准词数据。

评论任务 `a389e6b7-819f-4763-bdb7-18717f206931`：17成功、3 empty、0失败。B0F3NZ12GL、B0GQT4YJ5F、B0F43M9KWW 的保存来源 payload.data.details 均为 []；同站点历史也没有其他非空响应。Customers Say为空不等于商品没有评论。

## 修复

keyword-original-estimate 与 keyword-rule-report 原先只接受 ready/partial，将已验证的 empty 结果中的历史一并排除。现在允许读取 empty 中仍有效的历史观测，继续按具体月份值过滤；研究月未知仍未知，失败和未执行任务仍排除，来源时间/快照/步骤状态不改写。

关键词进度文案明确“研究月份无搜索量，其他月份历史仍保留”。评论展示3个空主题ASIN及来源已响应的原因，维持17/20和异常主题隔离，不伪造满覆盖。

## 验证

- 先复现失败：有历史的empty被输出为空数组；修复后两个专项回归通过，验证零值保留、研究月不补值、失败/排队不参与、事实不修改。
- 组合回归38通过、0失败、1跳过（需要外部原版样本文件）。首次误用react-server条件导致UI导入失败，改用正确条件后上述结果成立。
- typecheck、build、diff检查通过。
- 候选真实保存数据只读回放：100词，95词有历史，参考月仍89词有值。6词共23个已保存月份观测恢复进入历史分析，未补造9月数据。
- 32900与32901健康端点同一sourceHash：41b3aeefc6ac959a0e531d41896f0ec805ebb6d8038680a9b09b9ce982f30b51。候选已重启；正式31900/31901 PID155708/205440未变。
- Chrome评论页验证新缺口说明及3个ASIN可见。日志：.runtime/remaining-gaps-regression.log、remaining-gaps-typecheck.log、remaining-gaps-live-read.log、remaining-gaps-build.log。

限制：真正缺失的3个商品主题和5个词历史无法从现有缓存恢复；11个词仍缺研究月。此轮0真实MCP调用，不承诺恢复额度后来源一定有结果，也没有用模型生成内容代替来源。

Chrome关键词页最终确认：已有趋势95/100，趋势步骤完成100/100，11词研究月缺失，失败步骤0。截图：.runtime/remaining-gaps-95-trends.png。
