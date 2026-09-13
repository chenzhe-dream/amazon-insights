import assert from "node:assert/strict";
import { collectMarketProductPool } from "../../../server/services/market-product-pool-collector";
import { createMarketInputSnapshot } from "../../../server/domain/market-research/snapshot";
import { canonicalJsonSha256 as digest } from "../../../server/runtime/model-request-accounting";
import {
  createMarketShapeRevision,
  buildMarketShapePriceCatalog,
} from "../../../server/domain/market-research/shape-price-catalog";
const scope = {
  organizationId: "org-a",
  researchId: "a9000000-0000-4000-8000-000000000001",
  marketplace: "US" as const,
  nodeIdPath: "1:2:3",
  fromMonth: "2026-07",
  toMonth: "2026-08",
  currency: "USD" as const,
};
const cutoff = "2026-09-12T00:00:00.000Z",
  asins = ["B000000001", "B000000002", "B000000003"];
const rows = () =>
  asins.map((asin, i) => ({
    asin,
    title: "Lamp",
    brand: i === 2 ? null : "Brand A",
    price: i === 0 ? 5 : 15,
    totalUnits: i === 0 ? 100 : i === 1 ? 10 : 0,
    totalRevenue: 0,
    ranking: i + 1,
    rating: 4,
    ratings: 20,
    sellerName: "Fixture",
    sellerType: "FBA",
    shelfDate: i === 0 ? "2026-08-31" : i === 1 ? "2026-05-31" : null,
  }));
export async function observation(month: string, patch: (p: any) => void = () => {}) {
  const payload: any = {
    code: "OK",
    marketplace: "US",
    nodeIdPath: scope.nodeIdPath,
    month,
    currency: "USD",
    data: rows(),
  };
  patch(payload);
  const result = await collectMarketProductPool({
    scope,
    month,
    poolSize: 100,
    newProductMonths: 6,
    jobId: "shape-explanation",
    connector: {
      id: "sellerSprite",
      probe: async () => {
        throw Error("unused");
      },
      execute: async () => ({
        data: payload,
        source: {
          connectorId: "sellerSprite",
          operation: "market_product_concentration",
          fetchedAt: cutoff,
          attemptCount: 1,
        },
      }),
    },
    now: () => new Date(cutoff),
  });
  assert.ok(result.evidence);
  const source = result.evidence,
    sourceRef = "market-source:" + digest(source);
  const snapshot = createMarketInputSnapshot({
    scope,
    kind: "products",
    sourceVersion: "market-source-handlers/v1",
    ruleVersion: "source-normalization/v1",
    collectedAt: cutoff,
    expectedRecordIds: result.products.map((p) => p.asin),
    records: result.products.map((product) => ({
      id: product.asin,
      scope,
      data: { collection: "product-month", month, product, sourceRef },
    })),
  });
  return { month, snapshot, sourceRef, source };
}
export async function sourceCatalog(
  version:
    | "market-shape-price-catalog/v1"
    | "market-shape-price-catalog/v2"
    | "market-shape-price-catalog/v3" = "market-shape-price-catalog/v2",
  requestBound = false,
) {
  const clearEcho = (p: any) => { if (requestBound) { delete p.marketplace; delete p.nodeIdPath; delete p.month; delete p.currency; } };
  const reference = await observation("2026-08", clearEcho),
    history = await observation("2026-07", (p) => {
      p.data[1].totalUnits = 0;
      clearEcho(p);
    });
  const revision = createMarketShapeRevision({
    scope,
    basisSnapshotId: reference.snapshot.snapshotId,
    parentRevisionId: null,
    selectedAsins: asins,
    taxonomyVersion: "fixture/v1",
    labels: [
      { labelId: "desk", label: "Desk", definition: "Desk form" },
      { labelId: "shelf", label: "Shelf", definition: "Shelf form" },
    ],
    assignments: [
      { asin: asins[0], labelId: "desk" },
      { asin: asins[1], labelId: "desk" },
    ],
    authorId: "fixture",
    createdAt: cutoff,
    note: "",
  });
  return buildMarketShapePriceCatalog({
    reference,
    history: [history],
    sources: {
      [reference.sourceRef]: reference.source,
      [history.sourceRef]: history.source,
    },
    revision,
    bands: [
      { id: "low", minInclusive: 0, maxExclusive: 10 },
      { id: "high", minInclusive: 10, maxExclusive: null },
    ],
    dataCutoffAt: cutoff,
    version,
  });
}
