import { canonicalJsonSha256 as digest } from "../../runtime/model-request-accounting";
import {
  MarketShapeExplanationCatalogSchema,
  type MarketShapeExplanationCatalog,
  type MarketShapeExplanationDimension,
  type MarketShapeExplanationRow,
} from "../../../shared/market-shape-explanation-contracts";
import type { buildMarketShapePriceCatalog } from "./shape-price-catalog";

type SourceCatalog = Awaited<ReturnType<typeof buildMarketShapePriceCatalog>>;
const freeze = <T>(v: T): T => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const context = (v: Record<string, string | null>) => v;
const cell = (
  id: string,
  path: string,
  value: number | null,
  unit: string,
) => ({ id, path, value, unit });
function metrics(
  path: string,
  m: {
    totalUnits: number | null;
    eligibleLinkCount: number;
    linkMonthCount: number;
    monthlyUnitsPerLink: number | null;
  },
) {
  return [
    cell("totalUnits", `${path}.totalUnits`, m.totalUnits, "units"),
    cell(
      "eligibleLinkCount",
      `${path}.eligibleLinkCount`,
      m.eligibleLinkCount,
      "count",
    ),
    cell(
      "linkMonthCount",
      `${path}.linkMonthCount`,
      m.linkMonthCount,
      "link-months",
    ),
    cell(
      "monthlyUnitsPerLink",
      `${path}.monthlyUnitsPerLink`,
      m.monthlyUnitsPerLink,
      "units-per-link-month",
    ),
  ];
}
function ratio(
  prefix: string,
  path: string,
  r: {
    numerator: number | null;
    denominator: number | null;
    value: number | null;
  },
  quantityUnit: "count" | "units",
) {
  return [
    cell(`${prefix}.numerator`, `${path}.numerator`, r.numerator, quantityUnit),
    cell(
      `${prefix}.denominator`,
      `${path}.denominator`,
      r.denominator,
      quantityUnit,
    ),
    cell(`${prefix}.value`, `${path}.value`, r.value, "ratio"),
  ];
}
function stats(path: string, s: any) {
  return [
    cell("requestedLinks", `${path}.requestedLinks`, s.requestedLinks, "count"),
    cell(
      "comparableLinks",
      `${path}.comparableLinks`,
      s.comparableLinks,
      "count",
    ),
    cell("units", `${path}.units`, s.units, "units"),
    cell(
      "monthlyUnitsPerLink",
      `${path}.monthlyUnitsPerLink`,
      s.monthlyUnitsPerLink,
      "units-per-link-month",
    ),
    ...ratio("linkShare", `${path}.linkShare`, s.linkShare, "count"),
    ...ratio("salesShare", `${path}.salesShare`, s.salesShare, "units"),
  ];
}
function add(
  rows: MarketShapeExplanationRow[],
  dimension: MarketShapeExplanationDimension,
  id: string,
  path: string,
  ctx: Record<string, string | null>,
  cells: MarketShapeExplanationRow["cells"],
) {
  rows.push({ id, dimension, path, context: context(ctx), cells: [...cells] });
}
function validateSource(catalog: SourceCatalog) {
  const { catalogId, ...body } = catalog;
  if (catalogId !== "market-shape-price:" + digest(body))
    throw new TypeError("Shape price catalog digest differs");
}

/** Converts a saved, digest-verified price catalog into exhaustive numeric evidence.
 * Values are copied from their recorded paths; this layer performs no aggregation. */
export function buildMarketShapeExplanationCatalog(
  catalog: SourceCatalog,
): MarketShapeExplanationCatalog {
  validateSource(catalog);
  const rows: MarketShapeExplanationRow[] = [];
  const a = catalog.analysis;
  add(
    rows,
    "scope",
    "scope.coverage",
    "analysis.coverage",
    { coverageStatus: a.coverage.status },
    [
      cell(
        "requestedProductCount",
        "analysis.coverage.requestedProductCount",
        a.coverage.requestedProductCount,
        "count",
      ),
      cell(
        "eligibleProductCount",
        "analysis.coverage.eligibleProductCount",
        a.coverage.eligibleProductCount,
        "count",
      ),
      cell(
        "excludedProductCount",
        "analysis.coverage.excludedProductCount",
        a.coverage.excludedProductCount,
        "count",
      ),
      ...ratio(
        "eligibleProductRatio",
        "analysis.coverage.eligibleProductRatio",
        a.coverage.eligibleProductRatio,
        "count",
      ),
    ],
  );
  add(
    rows,
    "scope",
    "scope.totals",
    "analysis.totals",
    {},
    metrics("analysis.totals", a.totals),
  );
  const shapeLabel = (shape: string | null) =>
    shape === null
      ? null
      : (catalog.revision.labels.find((label) => label.labelId === shape)
          ?.label ?? null);
  a.shapes.forEach((shape, si) => {
    const sc = { shape: shape.shape, shapeLabel: shapeLabel(shape.shape) };
    add(
      rows,
      "shape",
      `shape.${si}.totals`,
      `analysis.shapes[${si}].totals`,
      sc,
      metrics(`analysis.shapes[${si}].totals`, shape.totals),
    );
    shape.bands.forEach((band, bi) => {
      const p = `analysis.shapes[${si}].bands[${bi}]`;
      add(
        rows,
        "price",
        `shape.${si}.price.${bi}`,
        p,
        {
          ...sc,
          priceBand: band.band.id,
          priceBandUpperBound:
            band.band.maxExclusive === null ? "unbounded" : "exclusive",
        },
        [
          cell(
            "band.minInclusive",
            `${p}.band.minInclusive`,
            band.band.minInclusive,
            catalog.scope.currency,
          ),
          cell(
            "band.maxExclusive",
            `${p}.band.maxExclusive`,
            band.band.maxExclusive,
            catalog.scope.currency,
          ),
          ...metrics(`${p}.metrics`, band.metrics),
          ...ratio(
            "salesShare",
            `${p}.salesShareWithinShape`,
            band.salesShareWithinShape,
            "units",
          ),
          ...ratio(
            "linkShare",
            `${p}.linkShareWithinShape`,
            band.linkShareWithinShape,
            "count",
          ),
        ],
      );
    });
  });
  catalog.structure?.segments.forEach((segment, si) => {
    const base = `structure.segments[${si}]`,
      sc = {
        segmentKind: segment.kind,
        shape: segment.labelId,
        shapeLabel: shapeLabel(segment.labelId),
      };
    segment.brands.forEach((brand, bi) => {
      const p = `${base}.brands[${bi}]`;
      add(
        rows,
        "brand",
        `segment.${si}.brand.${bi}`,
        p,
        { ...sc, brand: brand.brand },
        stats(`${p}.stats`, brand.stats),
      );
      brand.bands.forEach((band, bdi) => {
        const bp = `${p}.bands[${bdi}]`;
        add(
          rows,
          "brand",
          `segment.${si}.brand.${bi}.price.${bdi}`,
          bp,
          { ...sc, brand: brand.brand, priceBand: band.bandId },
          stats(`${bp}.stats`, band.stats),
        );
      });
    });
    segment.ages.forEach((age, ai) => {
      const p = `${base}.ages[${ai}]`;
      add(
        rows,
        "age",
        `segment.${si}.age.${ai}`,
        p,
        { ...sc, ageBand: age.bucketId },
        stats(`${p}.stats`, age.stats),
      );
    });
  });
  catalog.monthly.forEach((entry, mi) => {
    const base = `monthly[${mi}].analysis`,
      m = entry.analysis,
      mc = { month: entry.month };
    add(rows, "month", `month.${mi}.coverage`, `${base}.coverage`, mc, [
      cell(
        "requestedProductCount",
        `${base}.coverage.requestedProductCount`,
        m.coverage.requestedProductCount,
        "count",
      ),
      cell(
        "eligibleProductCount",
        `${base}.coverage.eligibleProductCount`,
        m.coverage.eligibleProductCount,
        "count",
      ),
      cell(
        "excludedProductCount",
        `${base}.coverage.excludedProductCount`,
        m.coverage.excludedProductCount,
        "count",
      ),
      ...ratio(
        "eligibleProductRatio",
        `${base}.coverage.eligibleProductRatio`,
        m.coverage.eligibleProductRatio,
        "count",
      ),
    ]);
    add(
      rows,
      "month",
      `month.${mi}.totals`,
      `${base}.totals`,
      mc,
      metrics(`${base}.totals`, m.totals),
    );
    m.shapes.forEach((shape, si) => {
      add(
        rows,
        "month",
        `month.${mi}.shape.${si}`,
        `${base}.shapes[${si}].totals`,
        { ...mc, shape: shape.shape, shapeLabel: shapeLabel(shape.shape) },
        metrics(`${base}.shapes[${si}].totals`, shape.totals),
      );
      shape.bands.forEach((band, bi) => {
        const p = `${base}.shapes[${si}].bands[${bi}]`;
        add(
          rows,
          "month",
          `month.${mi}.shape.${si}.price.${bi}`,
          p,
          {
            ...mc,
            shape: shape.shape,
            shapeLabel: shapeLabel(shape.shape),
            priceBand: band.band.id,
            priceBandUpperBound:
              band.band.maxExclusive === null ? "unbounded" : "exclusive",
          },
          [
            cell(
              "band.minInclusive",
              `${p}.band.minInclusive`,
              band.band.minInclusive,
              catalog.scope.currency,
            ),
            cell(
              "band.maxExclusive",
              `${p}.band.maxExclusive`,
              band.band.maxExclusive,
              catalog.scope.currency,
            ),
            ...metrics(`${p}.metrics`, band.metrics),
            ...ratio(
              "salesShare",
              `${p}.salesShareWithinShape`,
              band.salesShareWithinShape,
              "units",
            ),
            ...ratio(
              "linkShare",
              `${p}.linkShareWithinShape`,
              band.linkShareWithinShape,
              "count",
            ),
          ],
        );
      });
    });
  });
  const limitations: { code: string; detail: string }[] = [
    {
      code: "complete-common-members",
      detail: `All comparative sales use ${catalog.comparisonBasis}; requested and eligible member sets are retained.`,
    },
    {
      code: "reference-price-only",
      detail: `Prices use ${catalog.priceBasis}; historical price status is ${catalog.historicalPriceStatus}.`,
    },
    {
      code: "sample-not-market-ranking",
      detail:
        "The catalog describes the selected source product pool; it does not prove a whole-market or BSR Top 100 ranking.",
    },
  ];
  if (!catalog.structure)
    limitations.push({
      code: "structure-unavailable",
      detail: `${catalog.version} has no audited brand, brand-price-band, or listing-age structure.`,
    });
  if (a.shapes.some((shape) => shape.shape === null))
    limitations.push({
      code: "unclassified-shape",
      detail:
        "The null shape group contains products without a confirmed manual shape assignment.",
    });
  if ("sourcePolicy" in catalog)
    limitations.push({
      code: "source-policy-boundaries",
      detail: JSON.stringify(catalog.sourcePolicy),
    });
  const admission = catalog.products.flatMap(product => {
    if (!product.referencePrice.provenance) return [];
    const structural = catalog.structure?.products.find(p => p.asin === product.asin);
    return [{ asin: product.asin, price: product.referencePrice.provenance,
      observations: product.observations.map(o => ({ month: o.month, provenance: o.provenance ?? null })),
      brand: structural?.brand.scopeBasis ?? null, listing: structural?.listing.scopeBasis ?? null }];
  });
  if (admission.length) limitations.push({ code: 'source-admission-basis', detail: JSON.stringify(admission) });
  const structureWarnings =
    catalog.structure?.products.flatMap((product, pi) => [
      ...product.brand.issues.map((issue) => ({
        asin: product.asin,
        path: `structure.products[${pi}].brand`,
        issue,
        evidence: product.brand.evidence,
      })),
      ...product.listing.issues.map((issue) => ({
        asin: product.asin,
        path: `structure.products[${pi}].listing`,
        issue,
        evidence: product.listing.evidence,
      })),
    ]) ?? [];
  if (structureWarnings.length)
    limitations.push({
      code: "structure-source-warning",
      detail: JSON.stringify(structureWarnings),
    });
  if (a.coverage.status !== "complete")
    limitations.push({
      code: "incomplete-coverage",
      detail: `Coverage is ${a.coverage.status}: ${a.coverage.eligibleProductCount} of ${a.coverage.requestedProductCount} requested products are comparable.`,
    });
  const warnings = catalog.products.flatMap((p, pi) => [
    ...p.referencePrice.issues.map((issue) => ({
      asin: p.asin,
      path: `products[${pi}].referencePrice`,
      issue,
    })),
    ...p.observations.flatMap((o, oi) =>
      o.issues.map((issue) => ({
        asin: p.asin,
        path: `products[${pi}].observations[${oi}]`,
        month: o.month,
        issue,
      })),
    ),
  ]);
  if (warnings.length)
    limitations.push({
      code: "missing-source-field",
      detail: JSON.stringify(warnings),
    });
  if (a.unknownProducts.length)
    limitations.push({
      code: "unknown-product-fields",
      detail: JSON.stringify(a.unknownProducts),
    });
  if (a.excludedProducts.length)
    limitations.push({
      code: "excluded-products",
      detail: JSON.stringify(a.excludedProducts),
    });
  const body = {
    version: "market-shape-explanation-catalog/v1" as const,
    catalogId: catalog.catalogId,
    revisionId: catalog.revision.revisionId,
    scope: {
      ...catalog.scope,
      requestedAsins: [...a.scope.requestedAsins],
      eligibleAsins: [...a.scope.eligibleAsins],
    },
    source: {
      catalogVersion: catalog.version,
      dataCutoffAt: catalog.dataCutoffAt,
      referenceSnapshotId: catalog.referenceSnapshotId,
      inputSnapshotIds: [...catalog.inputSnapshotIds],
      sourceRefs: [
        ...new Set(
          catalog.products.flatMap((product) => [
            product.referencePrice.sourceRef,
            ...product.observations
              .map((observation) => observation.sourceRef)
              .filter((ref): ref is string => ref !== null),
          ]),
        ),
      ].sort(),
      comparisonBasis: catalog.comparisonBasis,
      priceBasis: catalog.priceBasis,
      historicalPriceStatus: catalog.historicalPriceStatus,
      structureRuleVersion: catalog.structure?.ruleVersion ?? null,
      sourcePolicy:
        "sourcePolicy" in catalog ? JSON.stringify(catalog.sourcePolicy) : null,
    },
    limitations,
    rows,
  };
  return freeze(
    MarketShapeExplanationCatalogSchema.parse({
      ...body,
      explanationCatalogId: "market-shape-explanation:" + digest(body),
    }),
  );
}
export function validateMarketShapeExplanationCatalog(
  value: unknown,
): MarketShapeExplanationCatalog {
  const parsed = MarketShapeExplanationCatalogSchema.parse(value),
    { explanationCatalogId, ...body } = parsed;
  if (explanationCatalogId !== "market-shape-explanation:" + digest(body))
    throw new TypeError("Shape explanation catalog digest differs");
  const rowIds = new Set<string>(),
    cellIds = new Set<string>(),
    cellPaths = new Set<string>();
  for (const row of parsed.rows) {
    if (rowIds.has(row.id)) throw new TypeError("Duplicate explanation row id");
    rowIds.add(row.id);
    for (const c of row.cells) {
      const key = `${row.id}\0${c.id}`;
      if (cellIds.has(key))
        throw new TypeError("Duplicate explanation cell id");
      cellIds.add(key);
      if (cellPaths.has(c.path))
        throw new TypeError("Duplicate explanation cell path");
      cellPaths.add(c.path);
    }
  }
  return freeze(parsed);
}
