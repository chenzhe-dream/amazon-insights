import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNC_STAGE_TEMPLATE,
  idleStageStatus,
  type AsinDataStatusItem,
} from "../../app/asin-sync-funnel";

const item: AsinDataStatusItem = {
  asin: "B0C4XRN398",
  inCatalog: true,
  keywords: "ready",
  reviews: "ready",
  sales: "missing",
  childSales: "ready",
  priceStrategy: "ready",
  fba: "ready",
  listing: "ready",
  imageRemarks: "missing",
  category: "ready",
  traffic: "ready",
  voc: "missing",
};

test("idle readiness maps every stage to its own field", () => {
  const states = Object.fromEntries(SYNC_STAGE_TEMPLATE.map(stage => [stage.id, idleStageStatus(stage.id, [item])]));
  assert.deepEqual(states, {
    catalog: "done",
    keywords: "done",
    reviews: "done",
    sales_trend: "pending",
    child_sales: "done",
    price_strategy: "done",
    fba: "done",
    listing: "done",
    image_remarks: "pending",
    category: "done",
    alexa_voc: "manual",
    traffic: "done",
  });
  assert.equal(Object.values(states).filter(value => value === "done").length, 9);
  assert.equal(Math.round((9 / SYNC_STAGE_TEMPLATE.length) * 100), 75);
});
