import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getProjectRoot } from "./project-root.mjs";
import { resolveRuntimeRoots } from "./runtime-roots.mjs";
import { parseImageList } from "./sorftime-listing-parse.mjs";
import { parseSorftimeCategoryTrend } from "./sorftime-trend-parse.mjs";

const SCHEMA_VERSION = 1;
const SOURCE = "Sorftime";
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function evidenceRoot({ root, env = process.env } = {}) {
  if (root) return path.resolve(root);
  const codeRoot = getProjectRoot();
  return path.join(resolveRuntimeRoots({ codeRoot, env }).runtimeRoot, "sync-evidence", "sorftime");
}

function normalizedIdentity({ jobId, marketplace, asin, operation }) {
  const normalizedMarketplace = String(marketplace ?? "").trim().toUpperCase();
  const normalizedAsin = String(asin ?? "").trim().toUpperCase();
  if (!SAFE_ID_PATTERN.test(String(jobId ?? ""))) throw new TypeError("Sorftime evidence jobId invalid");
  if (!SAFE_ID_PATTERN.test(normalizedMarketplace)) throw new TypeError("Sorftime evidence marketplace invalid");
  if (!ASIN_PATTERN.test(normalizedAsin)) throw new TypeError("Sorftime evidence ASIN invalid");
  if (!SAFE_ID_PATTERN.test(String(operation ?? ""))) throw new TypeError("Sorftime evidence operation invalid");
  return { jobId: String(jobId), marketplace: normalizedMarketplace, asin: normalizedAsin, operation: String(operation) };
}

function evidencePath(identity, options) {
  return path.join(
    evidenceRoot(options),
    identity.jobId,
    identity.marketplace,
    identity.asin,
    `${identity.operation}.json`,
  );
}

function normalizeProductDetailData(data) {
  const galleryImages = parseImageList(data?.galleryImages ?? data?.main_image);
  const hasAplus = data?.hasAplus === true || data?.a_plus === true
    ? true
    : data?.hasAplus === false || data?.a_plus === false
      ? false
      : null;
  const optionalNumber = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const optionalText = value => typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    galleryImages: galleryImages.slice(0, 32),
    hasAplus,
    title: optionalText(data?.title),
    fbaFee: optionalNumber(data?.fbaFee ?? data?.fba_fee),
    packageSize: optionalText(data?.packageSize ?? data?.package_size_cm),
    price: optionalNumber(data?.price),
    coupon: optionalNumber(data?.coupon),
    nodeId: data?.nodeId != null || data?.node_id != null
      ? optionalText(String(data?.nodeId ?? data?.node_id))
      : null,
    categoryName: optionalText(data?.categoryName ?? data?.subcategory ?? data?.category),
    topCategory: optionalText(data?.topCategory ?? data?.top_category),
  };
}

function normalizeVariationData(data) {
  const sourceRows = Array.isArray(data?.rows) ? data.rows : Array.isArray(data?.data) ? data.data : null;
  const normalizedRows = (sourceRows ?? []).map(row => {
      const asin = String(row?.asin ?? row?.Asin ?? "").trim().toUpperCase();
      const sales = Number(row?.sales ?? row?.SalesAmount ?? row?.sales_amount);
      if (!ASIN_PATTERN.test(asin) || !Number.isFinite(sales) || sales < 0) return null;
      return {
        asin,
        variant: String(row?.variant ?? row?.Property ?? row?.property ?? "未命名变体").trim() || "未命名变体",
        sales,
      };
    });
  const allSourceRowsValid = normalizedRows.every(Boolean);
  const rows = normalizedRows.filter(Boolean).slice(0, 100);
  const reportedTotalValue = data?.reportedTotal ?? sourceRows?.[0]?.ItemTotal ?? sourceRows?.[0]?.item_total;
  const reportedTotal = Number(reportedTotalValue);
  const hasReportedTotal = reportedTotalValue !== undefined && reportedTotalValue !== null && reportedTotalValue !== "";
  const verifiedComplete = sourceRows !== null && allSourceRowsValid && (typeof data?.verifiedComplete === "boolean"
    ? data.verifiedComplete
    : sourceRows.length === 0 && !hasReportedTotal
      ? true
      : hasReportedTotal && Number.isFinite(reportedTotal) && reportedTotal >= 0 && reportedTotal <= rows.length);
  return {
    rows,
    verifiedComplete,
    containerRecognized: sourceRows !== null,
    rawRowCount: sourceRows?.length ?? 0,
    validSalesRowCount: rows.length,
  };
}

function normalizeCategorySalesTrendData(data) {
  const points = Array.isArray(data?.points)
    ? data.points
    : parseSorftimeCategoryTrend(data?.response ?? data);
  return {
    nodeId: data?.nodeId != null ? String(data.nodeId).trim() : null,
    categoryName: typeof data?.categoryName === "string" ? data.categoryName.trim() : null,
    topCategory: typeof data?.topCategory === "string" ? data.topCategory.trim() : null,
    points: points
      .filter(point => /^\d{4}-\d{2}$/.test(String(point?.month ?? "")) && Number.isFinite(point?.value) && point.value >= 0)
      .map(point => ({ month: point.month, value: point.value }))
      .slice(-36),
  };
}

function normalizeEvidenceData(operation, data) {
  if (operation === "product_detail") return normalizeProductDetailData(data);
  if (operation === "product_variations") return normalizeVariationData(data);
  if (operation === "category_trend_sales_count") return normalizeCategorySalesTrendData(data);
  throw new TypeError("Sorftime evidence operation unsupported");
}

export function createProductDetailEvidence({
  jobId,
  marketplace,
  asin,
  fetchedAt = new Date().toISOString(),
  detail,
}) {
  const identity = normalizedIdentity({ jobId, marketplace, asin, operation: "product_detail" });
  const normalizedFetchedAt = new Date(fetchedAt).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    ...identity,
    fetchedAt: normalizedFetchedAt,
    source: SOURCE,
    provenance: {
      connector: "sorftime",
      tool: "product_detail",
      stageId: "catalog",
    },
    data: normalizeProductDetailData(detail),
  };
}

function createOperationEvidence({ jobId, marketplace, asin, fetchedAt = new Date().toISOString(), operation, data }) {
  const identity = normalizedIdentity({ jobId, marketplace, asin, operation });
  return {
    schemaVersion: SCHEMA_VERSION,
    ...identity,
    fetchedAt: new Date(fetchedAt).toISOString(),
    source: SOURCE,
    provenance: { connector: "sorftime", tool: operation, stageId: "catalog" },
    data: normalizeEvidenceData(operation, data),
  };
}

export function createProductVariationsEvidence(input) {
  return createOperationEvidence({ ...input, operation: "product_variations", data: input.response });
}

export function createCategorySalesTrendEvidence(input) {
  return createOperationEvidence({
    ...input,
    operation: "category_trend_sales_count",
    data: {
      response: input.response,
      nodeId: input.nodeId,
      categoryName: input.categoryName,
      topCategory: input.topCategory,
    },
  });
}

export function writeScopedSorftimeEvidence(evidence, options = {}) {
  const identity = normalizedIdentity(evidence);
  if (evidence.schemaVersion !== SCHEMA_VERSION || evidence.source !== SOURCE) {
    throw new TypeError("Sorftime evidence envelope invalid");
  }
  const fetchedAt = new Date(evidence.fetchedAt).toISOString();
  const value = {
    schemaVersion: SCHEMA_VERSION,
    ...identity,
    fetchedAt,
    source: SOURCE,
    provenance: { connector: "sorftime", tool: identity.operation, stageId: "catalog" },
    data: normalizeEvidenceData(identity.operation, evidence.data),
  };
  const target = evidencePath(identity, options);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  return value;
}

export function readScopedSorftimeEvidence(identityInput, options = {}) {
  const identity = normalizedIdentity(identityInput);
  const expectedFetchedAt = identityInput.fetchedAt == null
    ? null
    : new Date(identityInput.fetchedAt).toISOString();
  const target = evidencePath(identity, options);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
  try {
    const parsedIdentity = normalizedIdentity(parsed);
    if (
      parsed.schemaVersion !== SCHEMA_VERSION
      || parsed.source !== SOURCE
      || Object.keys(identity).some(key => parsedIdentity[key] !== identity[key])
    ) return null;
    const fetchedAt = new Date(parsed.fetchedAt).toISOString();
    if (expectedFetchedAt && fetchedAt !== expectedFetchedAt) return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      ...parsedIdentity,
      fetchedAt,
      source: SOURCE,
      provenance: { connector: "sorftime", tool: identity.operation, stageId: "catalog" },
      data: normalizeEvidenceData(identity.operation, parsed.data),
    };
  } catch {
    return null;
  }
}

export function readScopedSorftimeEvidenceByOperation(scope, options = {}) {
  return Object.fromEntries([
    "product_detail",
    "category_trend_sales_count",
    "product_variations",
  ].map(operation => [
    operation,
    readScopedSorftimeEvidence({ ...scope, operation }, options),
  ]).filter(([, evidence]) => evidence));
}
