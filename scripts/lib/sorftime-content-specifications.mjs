const labels = new Map([
  ["Color", "颜色"], ["Material", "材质"], ["Product Dimensions", "产品尺寸"],
  ["Item Weight", "产品重量"], ["Maximum Weight Recommendation", "最大建议承重"],
  ["Maximum Weight Capacity", "最大承重"], ["Weight Limit", "承重限制"],
  ["Age Range Description", "年龄范围"], ["Model Number", "型号"],
]);

function attributePairs(raw) {
  let value = raw;
  if (typeof value === "string") {
    if (value.length > 32_000) return [];
    try { value = JSON.parse(value); }
    catch {
      // Observed product_content encodes an array with escaped quote delimiters.
      if (!/^\[\s*\\"/.test(value)) return [];
      try { value = JSON.parse(value.replace(/\\"/g, '"')); } catch { return []; }
    }
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return []; }
    }
  }
  if (!Array.isArray(value) || value.length % 2 !== 0 || value.length > 128) return [];
  const pairs = [];
  for (let index = 0; index < value.length; index += 2) {
    const key = value[index], text = value[index + 1];
    if (typeof key !== "string" || typeof text !== "string") continue;
    if (labels.has(key.trim()) && text.trim() && text.length <= 500) pairs.push([key.trim(), text.trim()]);
  }
  return pairs;
}

/** Only explicit attribute tables are projected; prose and package metrics are excluded. */
export function parseSorftimeProductSpecifications(content) {
  const fields = new Map();
  for (const [key, value] of [...attributePairs(content?.property), ...attributePairs(content?.product_info)]) {
    if (!fields.has(key)) fields.set(key, value);
  }
  return [...fields].map(([key, value]) => `${labels.get(key)}：${value}`);
}

// Day-only legacy captures describe the entire day; retained specs keep their exact own time.
function captureUpperBound(value) {
  return typeof value === "string" ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value) : NaN;
}

function validRecordScope(record) {
  const provenance = record?.provenance;
  return record?.source === "Sorftime" && typeof provenance?.jobId === "string" && provenance.jobId.trim()
    && provenance.asin === record.asin && provenance.marketplace === record.marketplace
    && provenance.connector === "sorftime" && ["product_detail", "product_content"].includes(provenance.operation)
    && provenance.tool === provenance.operation && (provenance.stageId == null || provenance.stageId === "listing")
    && provenance.fetchedAt === record.fetchedAt && Number.isFinite(captureUpperBound(record.fetchedAt));
}

export function hasValidListingSpecificationsProvenance(record) {
  if (!validRecordScope(record)) return false;
  const specs = Object.hasOwn(record, "specificationsProvenance") ? record.specificationsProvenance : record.provenance;
  return specs?.jobId === record.provenance.jobId && specs.asin === record.asin && specs.marketplace === record.marketplace
    && specs.connector === "sorftime" && specs.operation === "product_content" && specs.tool === "product_content"
    && (specs.stageId == null || specs.stageId === "listing")
    && Number.isFinite(Date.parse(specs.fetchedAt)) && Date.parse(specs.fetchedAt) <= captureUpperBound(record.fetchedAt);
}

export function retainScopedListingSpecifications(record, existingRecord) {
  const usable = values => Array.isArray(values) && values.length > 0 && values.length <= 64
    && values.every(value => typeof value === "string" && value.trim() && value.length <= 600);
  if (usable(record.specifications)) {
    return validRecordScope(record) && record.provenance.operation === "product_content"
      ? { ...record, specificationsProvenance: { ...record.provenance } } : record;
  }
  if (!validRecordScope(record) || existingRecord?.status !== "ready" || !usable(existingRecord.specifications)
    || !hasValidListingSpecificationsProvenance(existingRecord)
    || record.asin !== existingRecord.asin || record.marketplace !== existingRecord.marketplace
    || record.provenance.jobId !== existingRecord.provenance.jobId) return record;
  const specificationsProvenance = existingRecord.specificationsProvenance ?? existingRecord.provenance;
  if (Date.parse(specificationsProvenance.fetchedAt) > captureUpperBound(record.fetchedAt)) return record;
  return { ...record, specifications: [...existingRecord.specifications], specificationsProvenance: { ...specificationsProvenance } };
}
