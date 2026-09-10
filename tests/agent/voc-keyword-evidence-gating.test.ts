import assert from "node:assert/strict";
import { test } from "node:test";
import { hasProductLaunchAnalysis } from "../../app/features/product-reports/product-launch-analysis";
import { hasVocDevelopmentData } from "../../app/features/voc/voc-development-summary";
import { hasLegacyVocDevelopmentData } from "../../server/domain/voc/legacy-summary";
const products = [{ asin: "B08L7DD8L9", brand: "Dimunt" }];
test("no manual VOC cannot silently use generated reviews", () => {
  assert.equal(hasProductLaunchAnalysis(products, { manualVocByAsin: {}, keywordDemand: null }), false);
});
test("ready reviews with no themes are not evidence", () => {
  assert.equal(hasVocDevelopmentData(products, {}, { B08L7DD8L9: { status: "ready", blocks: [] } }), false);
});
test("a dialog status alone is not manual evidence", () => {
  assert.equal(hasLegacyVocDevelopmentData(products, { B08L7DD8L9: { captureStatus: "dialog" } }, {}), false);
});
test("partial product coverage cannot claim the entire selected group ready", () => {
  assert.equal(hasLegacyVocDevelopmentData([...products, { asin: "B07498JDX4" }], {}, { B08L7DD8L9: { status: "ready", blocks: [{ key: "positives", rows: [{ label: "brightness", sharePct: 100 }] }] } }), false);
});
