import { normalizeProductDetailResponse } from './sorftime-product-contract.mjs';
import {sourceMetadata} from './sorftime-source-policy.mjs';
import { parseSorftimeProductSpecifications, retainScopedListingSpecifications } from './sorftime-content-specifications.mjs';
import { isExactMissingProductDetail } from './sorftime-product-availability.mjs';

function normalizeListingProductResponse(raw, { asin, marketplace, operation = 'product_detail' }) {
  const contentFields = ['main_image', 'description', 'property', 'feature', 'product_info', 'a_plus_images'];
  const missingContent = operation === 'product_content' && raw?.data?.asin === `#${asin}` &&
    Object.keys(raw.data).length === contentFields.length + 1 && contentFields.every(field => Object.hasOwn(raw.data, field) && raw.data[field] === null);
  const missing = marketplace === 'UK' && raw?.isError !== true && !Object.hasOwn(raw ?? {}, 'error') &&
    (raw?.code === undefined || raw.code === 'OK') && (operation === 'product_detail' ? isExactMissingProductDetail(raw, asin) : missingContent);
  // Keep placeholder numbers out of business data; content is queried independently.
  const data = missing ? { asin, main_image: null } : normalizeProductDetailResponse(raw, { asin, operation });
  for (const container of [raw, data]) {
    if (container?.asin != null && container.asin !== asin) throw Object.assign(new TypeError('Listing product ASIN mismatch'), { kind: 'schema' });
    for (const field of ['marketplace', 'amz_site']) {
      const value = container?.[field];
      if (value !== undefined && (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value.trim().toUpperCase()) || value.trim().toUpperCase() !== marketplace)) {
        throw Object.assign(new TypeError('Listing product marketplace mismatch'), { kind: 'schema', providerDiagnostic: { operation, boundary: 'consumer-shape' } });
      }
    }
  }
  return data;
}

function normalizeImageList(items) {
  return items
    .map(item => String(item ?? "").trim())
    .filter(item => /^https?:\/\//i.test(item));
}

export function parseImageList(raw) {
  if (Array.isArray(raw)) {
    return normalizeImageList(raw);
  }
  if (typeof raw !== "string" || !raw.trim()) return [];
  const value = raw.trim();
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return normalizeImageList(parsed);
    }
  } catch {
    return normalizeImageList([value]);
  }
  return [];
}

export function createDirectListingProvenance({ jobId, marketplace, asin, fetchedAt, operation = 'product_detail' }) {
  if (!jobId) return null;
  return {
    jobId: String(jobId),
    marketplace: String(marketplace).toUpperCase(),
    asin: String(asin).toUpperCase(),
    operation,
    fetchedAt: String(fetchedAt),
    connector: "sorftime",
    tool: operation,
    stageId: "listing",
  };
}

export function buildListingRecordFromProductDetailEvidence(evidence) {
  if (
    !evidence
    || evidence.source !== "Sorftime"
    || evidence.operation !== "product_detail"
    || !/^[A-Z0-9]{10}$/.test(String(evidence.asin ?? ""))
    || typeof evidence.marketplace !== "string"
    || typeof evidence.fetchedAt !== "string"
  ) {
    throw new TypeError("Scoped Sorftime product-detail evidence invalid");
  }
  const galleryImages = parseImageList(evidence.data?.galleryImages);
  const hasAplus = evidence.data?.hasAplus === true
    ? true
    : evidence.data?.hasAplus === false
      ? false
      : null;
  return {
    asin: evidence.asin,
    marketplace: evidence.marketplace,
    fetchedAt: evidence.fetchedAt,
    status: galleryImages.length > 0 || hasAplus != null ? "ready" : "empty",
    mainImage: galleryImages[0] ?? null,
    galleryImages,
    secondaryImages: galleryImages.slice(1),
    imageCount: galleryImages.length,
    hasAplus,
    hasEbc: null,
    hasVideo: null,
    lqs: null,
    source: "Sorftime",
    provenance: {
      jobId: evidence.jobId,
      marketplace: evidence.marketplace,
      asin: evidence.asin,
      operation: evidence.operation,
      fetchedAt: evidence.fetchedAt,
      connector: evidence.provenance?.connector ?? "sorftime",
      tool: evidence.provenance?.tool ?? "product_detail",
    },
  };
}

export function selectScopedListingRecord({
  evidence,
  existingRecord,
  forceRefresh = false,
  requireScopedEvidence = false,
}) {
  if (evidence) {
    const record = retainScopedListingSpecifications(buildListingRecordFromProductDetailEvidence(evidence), existingRecord);
    return record.galleryImages.length ? record : null;
  }
  if (requireScopedEvidence) return null;
  if (!forceRefresh && existingRecord?.status === "ready" && existingRecord.galleryImages?.length) {
    return existingRecord;
  }
  return null;
}

export function discardUnscopedListingRecord(records, asin) {
  delete records[asin];
}

export async function collectListingProductData({ asin, marketplace, key, callTool, detailEvidence, refreshImages = false }) {
  let detail = detailEvidence?.data;
  let sourceFetchedAt = detailEvidence?.fetchedAt;
  if (!detail) {
    const raw = await callTool(key, 'product_detail', { asin, amz_site: marketplace }, {forceRefresh:refreshImages});
    sourceFetchedAt = sourceMetadata(raw)?.fetchedAt;
    detail = normalizeListingProductResponse(raw, { asin, marketplace });
  }
  let galleryImages = refreshImages && detailEvidence ? [] : parseImageList(detail.galleryImages ?? detail.main_image);
  const hasAplus = detail.hasAplus === true || detail.a_plus === true ? true : detail.hasAplus === false || detail.a_plus === false ? false : null;
  let operation = 'product_detail';
  let specifications;
  if (!galleryImages.length) {
    try {
      const raw = await callTool(key, 'product_content', { asin, amz_site: marketplace }, {forceRefresh:refreshImages});
      sourceFetchedAt = sourceMetadata(raw)?.fetchedAt ?? sourceFetchedAt;
      const content = normalizeListingProductResponse(raw, { asin, marketplace, operation: 'product_content' });
      if (content.asin !== asin) throw Object.assign(new TypeError('Product content ASIN missing'), { kind: 'schema' });
      galleryImages = parseImageList(content.main_image);
      if (Object.hasOwn(content, 'property') || Object.hasOwn(content, 'product_info')) {
        specifications = parseSorftimeProductSpecifications(content);
      }
      operation = 'product_content';
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      error.listingDetailSignals = { hasAplus, operation: 'product_detail' };
      throw error;
    }
  }
  return { galleryImages, hasAplus, operation, ...(sourceFetchedAt?{sourceFetchedAt}:{}), ...(specifications ? { specifications } : {}) };
}

export function buildListingFailureRecord({ asin, marketplace, jobId, fetchedAt, error }) {
  const signals = error?.listingDetailSignals;
  return {
    asin, marketplace, fetchedAt, status: 'error',
    statusMessage: error instanceof Error ? error.message : String(error),
    mainImage: null, galleryImages: [], secondaryImages: [], imageCount: 0,
    hasAplus: signals?.hasAplus ?? null, hasEbc: null, hasVideo: null, lqs: null,
    source: 'Sorftime',
    provenance: signals ? createDirectListingProvenance({ asin, marketplace, jobId, fetchedAt, operation: signals.operation }) : null,
  };
}
