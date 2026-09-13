export type ShapePriceBand = {
  id: string;
  minInclusive: number;
  maxExclusive: number | null;
};

export type ShapePriceProduct = {
  asin: string;
  shape: string | null;
  price: number | null;
  brand: string | null;
  monthlySales: readonly { month: string; units: number | null }[];
};

export type ShapePriceAnalysisInput = {
  /** Nonempty chronological consecutive complete months; the caller checks recency. */
  months: readonly string[];
  /** All prices and bounds must already use the same currency and monetary unit. */
  bands: readonly ShapePriceBand[];
  products: readonly ShapePriceProduct[];
};

export type ShapePriceRatio = {
  unit: "ratio";
  numerator: number | null;
  denominator: number | null;
  /** Unrounded 0–1 ratio; null when the numerator is unknown or denominator is absent/zero. */
  value: number | null;
};

export type ShapePriceMetrics = {
  /** Sum over eligible members and all requested months; null means no observed members. */
  totalUnits: number | null;
  eligibleLinkCount: number;
  /** Denominator of monthlyUnitsPerLink: eligibleLinkCount × requested month count. */
  linkMonthCount: number;
  monthlyUnitsPerLink: number | null;
};

export type ShapePriceIssue =
  | { code: "unknown_price" | "unmapped_price" | "unknown_shape" | "unknown_brand" }
  | { code: "missing_month" | "unknown_sales"; month: string };

export type ShapePriceProductIssue = {
  asin: string;
  reasons: ShapePriceIssue[];
};

export type ShapePriceBandResult = {
  band: ShapePriceBand;
  eligibleAsins: string[];
  metrics: ShapePriceMetrics;
  /** Band eligible units / all eligible units in this shape over the requested months. */
  salesShareWithinShape: ShapePriceRatio;
  /** Band eligible links / all eligible links in this shape. */
  linkShareWithinShape: ShapePriceRatio;
};

export type ShapePriceShapeResult = {
  /** null is the unclassified group, never an inferred product shape. */
  shape: string | null;
  requestedAsins: string[];
  eligibleAsins: string[];
  totals: ShapePriceMetrics;
  bands: ShapePriceBandResult[];
};

export type ShapePriceAnalysisResult = {
  months: string[];
  scope: { requestedAsins: string[]; eligibleAsins: string[] };
  /** Eligibility coverage only; unknown shape/brand does not exclude an otherwise comparable link. */
  coverage: {
    status: "complete" | "partial" | "none";
    requestedProductCount: number;
    eligibleProductCount: number;
    excludedProductCount: number;
    eligibleProductRatio: ShapePriceRatio;
  };
  totals: ShapePriceMetrics;
  shapes: ShapePriceShapeResult[];
  excludedProducts: ShapePriceProductIssue[];
  /** Missing fields, including nonblocking shape/brand; unmapped known prices are exclusions only. */
  unknownProducts: ShapePriceProductIssue[];
};

type EligibleProduct = { asin: string; bandId: string; monthlyUnits: number[] };
type ShapeMembers = { requestedAsins: string[]; eligible: EligibleProduct[] };

function nonnegativeFinite(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite nonnegative number`);
  }
}

function monthIndex(value: unknown): number {
  if (typeof value !== "string" || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new RangeError("month must use a valid YYYY-MM calendar month");
  }
  const year = Number(value.slice(0, 4));
  if (year === 0) throw new RangeError("month year must be at least 0001");
  return year * 12 + Number(value.slice(5)) - 1;
}

function label(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a nonempty string`);
  }
  return value.trim();
}

function optionalLabel(value: unknown, field: string): string | null {
  return value === null ? null : label(value, field);
}

function finiteSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isFinite(result)) throw new RangeError("sales aggregation must remain finite (overflow)");
  return result;
}

function ratio(numerator: number | null, denominator: number | null): ShapePriceRatio {
  return {
    unit: "ratio", numerator, denominator,
    value: numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator,
  };
}

function aggregate(members: readonly EligibleProduct[], monthCount: number): ShapePriceMetrics {
  const linkMonthCount = members.length * monthCount;
  if (!Number.isFinite(linkMonthCount)) throw new RangeError("link-month denominator must remain finite");
  let totalUnits: number | null = null;
  if (members.length > 0) {
    totalUnits = 0;
    for (const member of members) {
      for (const units of member.monthlyUnits) totalUnits = finiteSum(totalUnits, units);
    }
  }
  return {
    totalUnits, eligibleLinkCount: members.length, linkMonthCount,
    monthlyUnitsPerLink: totalUnits === null ? null : totalUnits / linkMonthCount,
  };
}

function validatedBands(source: readonly ShapePriceBand[]): ShapePriceBand[] {
  if (!Array.isArray(source) || source.length === 0) throw new RangeError("bands must be nonempty");
  const ids = new Set<string>();
  const bands = source.map((band) => {
    if (!band || typeof band !== "object") throw new TypeError("band must be an object");
    const id = label(band.id, "band id");
    if (ids.has(id)) throw new RangeError(`duplicate band id: ${id}`);
    ids.add(id);
    nonnegativeFinite(band.minInclusive, `band ${id} minInclusive`);
    if (band.maxExclusive !== null) {
      nonnegativeFinite(band.maxExclusive, `band ${id} maxExclusive`);
      if (band.maxExclusive <= band.minInclusive) throw new RangeError(`band ${id} must have positive width`);
    }
    return { id, minInclusive: band.minInclusive, maxExclusive: band.maxExclusive };
  });
  const sorted = [...bands].sort((left, right) => left.minInclusive - right.minInclusive);
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    if (previous.maxExclusive === null || sorted[index].minInclusive < previous.maxExclusive) {
      throw new RangeError(`price bands overlap: ${previous.id}, ${sorted[index].id}`);
    }
  }
  return bands;
}

/**
 * Pure descriptive rules over the caller's requested pool, never a whole-market claim.
 * ASINs are trimmed/uppercased; shape, brand, and band labels are trimmed and case-sensitive.
 * Only a mapped price and known sales in every requested month admit a product.
 * Unknown shape/brand is retained; this function performs no semantic classification.
 */
export function analyzeShapePriceBands(input: ShapePriceAnalysisInput): ShapePriceAnalysisResult {
  if (!input || typeof input !== "object") throw new TypeError("shape/price input must be an object");
  if (!Array.isArray(input.months) || input.months.length === 0) throw new RangeError("months must be nonempty");
  const months = [...input.months];
  const monthIndices = months.map(monthIndex);
  for (let index = 1; index < monthIndices.length; index++) {
    if (monthIndices[index] !== monthIndices[index - 1] + 1) {
      throw new RangeError("months must be chronological and consecutive without duplicates");
    }
  }
  const bands = validatedBands(input.bands);
  if (!Array.isArray(input.products)) throw new TypeError("products must be an array");
  const requestedAsins: string[] = [];
  const seenAsins = new Set<string>();
  const eligible: EligibleProduct[] = [];
  const shapeMembers = new Map<string | null, ShapeMembers>();
  const excludedProducts: ShapePriceProductIssue[] = [];
  const unknownProducts: ShapePriceProductIssue[] = [];

  for (const product of input.products) {
    if (!product || typeof product !== "object") throw new TypeError("product must be an object");
    const asin = label(product.asin, "ASIN").toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new RangeError(`invalid ASIN: ${asin}`);
    if (seenAsins.has(asin)) throw new RangeError(`duplicate ASIN: ${asin}`);
    seenAsins.add(asin);
    requestedAsins.push(asin);
    const shape = optionalLabel(product.shape, `${asin} shape`);
    const brand = optionalLabel(product.brand, `${asin} brand`);
    if (product.price !== null) nonnegativeFinite(product.price, `${asin} price`);
    if (!Array.isArray(product.monthlySales)) throw new TypeError(`${asin} monthlySales must be an array`);
    const sales = new Map<string, number | null>();
    for (const observation of product.monthlySales) {
      if (!observation || typeof observation !== "object") throw new TypeError(`${asin} monthly sale must be an object`);
      monthIndex(observation.month);
      if (sales.has(observation.month)) throw new RangeError(`duplicate sales month for ${asin}: ${observation.month}`);
      if (observation.units !== null) nonnegativeFinite(observation.units, `${asin} ${observation.month} units`);
      sales.set(observation.month, observation.units);
    }

    const band = product.price === null ? undefined : bands.find((candidate) =>
      product.price! >= candidate.minInclusive && (candidate.maxExclusive === null || product.price! < candidate.maxExclusive));
    const exclusions: ShapePriceIssue[] = [];
    if (product.price === null) exclusions.push({ code: "unknown_price" });
    else if (!band) exclusions.push({ code: "unmapped_price" });
    const monthlyUnits: number[] = [];
    for (const month of months) {
      const units = sales.get(month);
      if (units === undefined) exclusions.push({ code: "missing_month", month });
      else if (units === null) exclusions.push({ code: "unknown_sales", month });
      else monthlyUnits.push(units);
    }
    const unknowns: ShapePriceIssue[] = [];
    if (shape === null) unknowns.push({ code: "unknown_shape" });
    if (brand === null) unknowns.push({ code: "unknown_brand" });
    unknowns.push(...exclusions.filter((reason) => reason.code !== "unmapped_price"));
    if (unknowns.length > 0) unknownProducts.push({ asin, reasons: unknowns });

    let members = shapeMembers.get(shape);
    if (!members) {
      members = { requestedAsins: [], eligible: [] };
      shapeMembers.set(shape, members);
    }
    members.requestedAsins.push(asin);
    if (exclusions.length > 0) excludedProducts.push({ asin, reasons: exclusions });
    else if (band) {
      const member = { asin, bandId: band.id, monthlyUnits };
      eligible.push(member);
      members.eligible.push(member);
    }
  }

  const shapes = [...shapeMembers].map(([shape, members]): ShapePriceShapeResult => {
    const totals = aggregate(members.eligible, months.length);
    return {
      shape, requestedAsins: members.requestedAsins, eligibleAsins: members.eligible.map((member) => member.asin), totals,
      bands: bands.map((band) => {
        const bandMembers = members.eligible.filter((member) => member.bandId === band.id);
        const metrics = aggregate(bandMembers, months.length);
        return {
          band: { ...band }, eligibleAsins: bandMembers.map((member) => member.asin), metrics,
          salesShareWithinShape: ratio(metrics.totalUnits, totals.totalUnits),
          linkShareWithinShape: ratio(metrics.eligibleLinkCount, totals.eligibleLinkCount),
        };
      }),
    };
  });
  return {
    months,
    scope: { requestedAsins, eligibleAsins: eligible.map((member) => member.asin) },
    coverage: {
      status: eligible.length === 0 ? "none" : eligible.length === requestedAsins.length ? "complete" : "partial",
      requestedProductCount: requestedAsins.length,
      eligibleProductCount: eligible.length,
      excludedProductCount: excludedProducts.length,
      eligibleProductRatio: ratio(eligible.length, requestedAsins.length),
    },
    totals: aggregate(eligible, months.length), shapes, excludedProducts, unknownProducts,
  };
}
