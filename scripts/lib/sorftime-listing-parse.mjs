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
  if (evidence) return buildListingRecordFromProductDetailEvidence(evidence);
  if (requireScopedEvidence) return null;
  if (!forceRefresh && existingRecord?.status === "ready" && existingRecord.galleryImages?.length) {
    return existingRecord;
  }
  return null;
}

export function discardUnscopedListingRecord(records, asin) {
  delete records[asin];
}
