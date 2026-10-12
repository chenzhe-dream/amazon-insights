function schemaError(message, operation = 'product_detail') {
  return Object.assign(new TypeError(message), { kind: 'schema', providerDiagnostic: { operation, boundary: 'consumer-shape' } });
}

export function normalizeProductDetailResponse(raw, { asin, operation = 'product_detail' }) {
  const data = raw?.data ?? raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw schemaError('Product response invalid', operation);
  if (data.asin != null && data.asin !== asin) throw schemaError('Product response ASIN mismatch', operation);
  // Legacy responses omit ASIN. Current doc/data envelopes must identify their product.
  if (raw?.doc != null && data.asin !== asin) throw schemaError('Product response ASIN missing', operation);
  return data;
}

export function resolveProductCategory(raw, { asin }) {
  const data = normalizeProductDetailResponse(raw, { asin });
  const clean = value => typeof value === 'string' ? value.replace(/\s*\(Rank:\s*\d+\)\s*$/i, '').trim() : '';
  if (Object.hasOwn(data, 'sub_category')) {
    if (data.asin !== asin || !Array.isArray(data.sub_category)) throw schemaError('Category identity unavailable');
    if (!data.sub_category.length) {
      if (data.node_id != null && data.node_id !== '') throw schemaError('Category node ambiguous');
      return null;
    }
    if (data.sub_category.length !== 1) throw schemaError('Category node ambiguous');
    const tuple = data.sub_category[0];
    if (!Array.isArray(tuple) || tuple.length !== 4 || !clean(tuple[0]) || !/^\d+$/.test(String(tuple[1])) || !/^\d+$/.test(String(tuple[2])) || !/^\d{8}$/.test(String(tuple[3]))) throw schemaError('Category tuple malformed');
    if (data.node_id != null && String(data.node_id) !== String(tuple[1])) throw schemaError('Category node ambiguous');
    if (data.category != null && (!Array.isArray(data.category) || data.category.length !== 2 || data.category.some(value => typeof value !== 'string' || !value.trim()))) throw schemaError('Top category malformed');
    return { nodeId: String(tuple[1]), categoryName: clean(tuple[0]), topCategory: clean(data.category?.[0]), sourceAsin: asin };
  }
  if (data.asin === asin && data.node_id === '') return null;
  const nodeId = data.node_id != null ? String(data.node_id) : '';
  if (!nodeId || !/^\d+$/.test(nodeId)) throw schemaError('Category node unavailable');
  return { nodeId, categoryName: clean(data.subcategory) || clean(data.category) || '未知类目', topCategory: clean(data.top_category), sourceAsin: asin };
}
