import assert from "node:assert/strict";
import test from "node:test";
import { formatManualVocMatrixText } from "../../app/voc-display-schema";

test("hides only missing mention-rate prefixes while retaining facts and quotes", () => {
  assert.equal(formatManualVocMatrixText("【外观】暂无数据：好评率100%，用户声音：漂亮", "positives"), "【外观】好评率100%，用户声音：漂亮");
  assert.equal(formatManualVocMatrixText("【质量】 暂无数据: 用户声音：暂无数据可供比较", "negatives"), "【质量】用户声音：暂无数据可供比较");
});

test("keeps actual percentages, empty-state messages and other dimensions", () => {
  const rows = ["【质量】约 12% 评论提及（12 条）", "暂无数据", "【质量】暂无数据：", "【质量】用户说：暂无数据"];
  for (const row of rows) assert.equal(formatManualVocMatrixText(row, "positives"), row);
  const row = "【质量】暂无数据：原始描述";
  assert.equal(formatManualVocMatrixText(row, "motives"), row);
});
