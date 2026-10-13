import assert from "node:assert/strict";
import test from "node:test";
import { collectListingProductData, createDirectListingProvenance, selectScopedListingRecord } from "../../scripts/lib/sorftime-listing-parse.mjs";
import { createProductDetailEvidence } from "../../scripts/lib/scoped-sorftime-evidence.mjs";

const asin = "B0BT9F1F72";
const images = ["https://img.test/board.jpg"];

test("listing content retains explicitly returned product specifications without confusing packaging", async () => {
  const calls = [];
  const product = await collectListingProductData({ asin, marketplace: "US", key: "fixture", callTool: async (_key, operation) => {
    calls.push(operation);
    return { data: operation === "product_detail" ? { asin, a_plus: true, package_size_cm: ["76.2,30.48,14.61"] } : {
      asin, main_image: images,
      property: String.raw`[\"Brand\",\"ZUKAM\",\"Color\",\"Claw\",\"Material\",\"Wood\",\"Product Dimensions\",\"29.53 L x 11.02 W inches\"]`,
      product_info: JSON.stringify(["Material", "Wood", "Maximum Weight Recommendation", "300 Pounds"]),
      description: "Claims in prose are not inferred as specifications",
    } };
  } });
  assert.deepEqual(calls, ["product_detail", "product_content"]);
  assert.deepEqual(product.galleryImages, images);
  assert.deepEqual(product.specifications, ["颜色：Claw", "材质：Wood", "产品尺寸：29.53 L x 11.02 W inches", "最大建议承重：300 Pounds"]);
  assert.equal(product.operation, "product_content");
  assert.doesNotMatch(product.specifications.join(" "), /76\.2|Claims|ZUKAM/);
});

test("malformed optional attribute tables do not discard a valid gallery or invent specifications", async () => {
  const product = await collectListingProductData({ asin, marketplace: "US", key: "fixture", callTool: async (_key, operation) => ({ data:
    operation === "product_detail" ? { asin, a_plus: true } : { asin, main_image: images, property: "[broken", product_info: ["Material"], description: "Wood" }
  }) });
  assert.deepEqual(product.galleryImages, images);
  assert.deepEqual(product.specifications, []);
});

test("legacy details with a gallery do not cause an extra material request", async () => {
  let count = 0;
  const product = await collectListingProductData({ asin, marketplace: "US", key: "fixture", callTool: async () => {
    count += 1; return { data: { asin, main_image: images, a_plus: true } };
  } });
  assert.equal(count, 1);
  assert.deepEqual(product.galleryImages, images);
  assert.equal(product.specifications, undefined);
});

test("wrong product material identity rejects rather than cross-filling specifications", async () => {
  await assert.rejects(collectListingProductData({ asin, marketplace: "US", key: "fixture", callTool: async (_key, operation) => ({ data:
    operation === "product_detail" ? { asin } : { asin: "B0OTHER001", main_image: images, property: ["Material", "Wood"] }
  }) }), /ASIN/);
});

test("same-job gallery reconstruction retains product_content specs with their original collection time", () => {
  const collected = "2026-10-12T10:00:00.000Z";
  const evidence = createProductDetailEvidence({ jobId: "current-job", asin, marketplace: "US", fetchedAt: "2026-10-13T10:00:00.000Z", detail: { asin, main_image: images } });
  const existingRecord = { asin, marketplace: "US", fetchedAt: collected, source: "Sorftime", status: "ready", galleryImages: images, specifications: ["材质：Wood"], provenance: createDirectListingProvenance({ jobId: "current-job", asin, marketplace: "US", fetchedAt: collected, operation: "product_content" }) };
  const selected = selectScopedListingRecord({ evidence, existingRecord });
  assert.deepEqual(selected.specifications, existingRecord.specifications);
  assert.equal(selected.fetchedAt, evidence.fetchedAt);
  assert.equal(selected.specificationsProvenance.fetchedAt, collected);
  assert.equal(selected.specificationsProvenance.operation, "product_content");
  for (const changed of [{ source: "SellerSprite" }, { asin: "B000000000" }, { marketplace: "CA" }, { provenance: undefined }, { provenance: { ...existingRecord.provenance, jobId: "old-job" } }, { provenance: { ...existingRecord.provenance, asin: "B000000000" } }, { provenance: { ...existingRecord.provenance, marketplace: "CA" } }, { provenance: { ...existingRecord.provenance, fetchedAt: "2099-01-01" } }, { provenance: { ...existingRecord.provenance, connector: "unknown" } }]) {
    assert.equal(selectScopedListingRecord({ evidence, existingRecord: { ...existingRecord, ...changed } }).specifications, undefined);
  }
});

test("top-level and nested marketplace declarations cannot cross-fill listing data", async () => {
  for (const operation of ["product_detail", "product_content"]) {
    for (const key of ["marketplace", "amz_site"]) {
      for (const atTop of [true, false]) {
        await assert.rejects(collectListingProductData({ asin, marketplace: "US", key: "fixture", callTool: async (_key, name) => {
          const data = { asin, ...(name === "product_content" ? { main_image: images, property: ["Material", "Wood"] } : {}) };
          return name === operation ? (atTop ? { [key]: "CA", data } : { data: { ...data, [key]: "CA" } }) : { data };
        } }), /marketplace/, `${operation} ${key} ${atTop ? "top" : "nested"}`);
      }
    }
  }
});
