import assert from "node:assert/strict";
import test from "node:test";
import { xydcRepairReason } from "../../scripts/run-asin-sync-job.mjs";
test("Xiyou runner reason separates completed orders from exact child detail gaps", () => {
  const asin = "B0BWCQHCWX";
  const reason = xydcRepairReason({ repairOrders: { [asin]: "ready" }, repairDetails: { [asin]: [{ asin: "B0H2LS8SB6", fields: ["title", "stars", "productPageRatings"] }] } }, asin);
  assert.equal(reason, "全年订单已完整；B0H2LS8SB6：标题、评分、评论数未返回");
  assert.doesNotMatch(reason, /订单待补齐|全年订单仍有缺口/);
});
test("order-only gaps do not invent child concerns when diagnostics exist", () => {
  assert.equal(xydcRepairReason({ repairDetails: {}, repairOrders: {} }, "B0BWCQHCWX"), "全年订单待补齐");
});
import { createXydcDiagnosticParser } from "../../scripts/run-asin-sync-job.mjs";
test("bounded collector diagnostic parser accepts split CRLF, fields and scoped parents only", () => {
  const parser = createXydcDiagnosticParser(["B0BWCQHCWX"], true);
  const input = "[xydc-orders] B0BWCQHCWX ready\r\n[xydc-detail] B0BWCQHCWX B0H2LS8SB6 title,imageUrl,price,currency,stars,productPageRatings\r\n[xydc-detail] B0OUTSIDE1 B0H2LS8SB6 stars\n[xydc-detail] B0BWCQHCWX B0H2LS8SB6 secret\n";
  for (let index = 0; index < input.length; index += 7) parser.push(Buffer.from(input.slice(index, index + 7)));
  assert.deepEqual(parser.result.repairDetails, { B0BWCQHCWX: [{ asin: "B0H2LS8SB6", fields: ["title", "imageUrl", "price", "currency", "stars", "productPageRatings"] }] });
  assert.equal(xydcRepairReason(parser.result, "B0BWCQHCWX"), "全年订单已完整；B0H2LS8SB6：标题、图片、价格、币种、评分、评论数未返回");
});
