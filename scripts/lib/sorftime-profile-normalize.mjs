import { parseImageList } from './sorftime-listing-parse.mjs';
import { resolveProductCategory } from './sorftime-product-contract.mjs';

const schemaError = () => new TypeError('Sorftime catalog schema invalid');

export function normalizeSorftimeDetailIdentity(raw, { asin, marketplace }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw schemaError();
  if (raw.isError === true || Object.hasOwn(raw, 'error')) throw schemaError();
  if (Object.keys(raw).length === 2 && typeof raw.code === 'string' && raw.code.trim() && typeof raw.message === 'string' && raw.message.trim()) throw schemaError();
  const data = Object.hasOwn(raw, 'data') ? raw.data : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw schemaError();
  if (typeof asin !== 'string' || !/^[A-Z0-9]{10}$/.test(asin)) throw schemaError();
  if (marketplace != null && (typeof marketplace !== 'string' || !/^[A-Z]{2}$/.test(marketplace.trim().toUpperCase()))) throw schemaError();
  if (Object.hasOwn(data, 'asin') && (typeof data.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(data.asin) || data.asin !== asin)) {
    throw new TypeError('Sorftime catalog ASIN mismatch');
  }
  if (raw.doc != null && data.asin !== asin) throw new TypeError('Sorftime catalog ASIN missing');
  for (const value of [raw.marketplace, raw.amz_site, data.marketplace, data.amz_site]) {
    if (value !== undefined && (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value.trim().toUpperCase()) || (marketplace != null && value.trim().toUpperCase() !== marketplace.trim().toUpperCase()))) {
      throw new TypeError('Sorftime catalog marketplace mismatch');
    }
  }
  return data;
}

export function sorftimeOptionalText(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw schemaError();
  const text = value.trim();
  return !text || text.toLowerCase() === 'null' ? null : text;
}

export function sorftimeOptionalNumber(value, { unknownSentinel = false, integer = false, maximum = Infinity } = {}) {
  if (value == null || (unknownSentinel && value === -1)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum || (integer && !Number.isInteger(value))) throw schemaError();
  return value;
}

export function normalizeSorftimePackageSize(value, { includeUnit = true } = {}) {
  let text;
  if (Array.isArray(value)) {
    if (value.length !== 1 || typeof value[0] !== 'string') throw schemaError();
    const dimensions = value[0].split(',').map(item => item.trim());
    if (dimensions.length !== 3 || dimensions.some(item => !/^\d+(?:\.\d+)?$/.test(item) || Number(item) <= 0)) throw schemaError();
    text = dimensions.join(' x ');
    // The current array contract declares centimeters explicitly.
    return `${text} cm`;
  }
  text = sorftimeOptionalText(value);
  if (!text) return null;
  return !includeUnit || /\bcm\b/i.test(text) ? text : `${text} cm`;
}

export function normalizeSorftimeCategories(data, asin) {
  if (Object.hasOwn(data, 'sub_category')) {
    const category = resolveProductCategory(data, { asin });
    const rank = category ? Number(data.sub_category[0][2]) : null;
    return { rankCategory: category?.topCategory || null, subRankCategory: category?.categoryName || null, subRank: rank, nodeId: category?.nodeId || null };
  }
  const clean = value => sorftimeOptionalText(value)?.replace(/\s*\(Rank:\s*\d+\)\s*$/i, '').trim() || null;
  return { rankCategory: clean(data.top_category), subRankCategory: clean(data.subcategory), subRank: null, nodeId: sorftimeOptionalText(data.node_id) };
}

export function normalizeSorftimeProfile(raw, identity) {
  const data = normalizeSorftimeDetailIdentity(raw, identity);
  const images = data.main_image;
  if (images != null && (typeof images !== 'string' && !Array.isArray(images) || Array.isArray(images) && images.some(value => value != null && typeof value !== 'string'))) throw schemaError();
  if (data.is_fba != null && typeof data.is_fba !== 'boolean') throw schemaError();
  const listingDate = sorftimeOptionalText(data.listing_date);
  const launch = listingDate && /^\d{4}-\d{2}-\d{2}$/.test(listingDate) && !Number.isNaN(Date.parse(listingDate)) && new Date(listingDate).toISOString().slice(0, 10) === listingDate ? listingDate : null;
  const weight = sorftimeOptionalNumber(data.weight_g, { unknownSentinel: true });
  const variations = sorftimeOptionalNumber(data.variation_count, { integer: true });
  return {
    title: sorftimeOptionalText(data.title), image: parseImageList(images)[0] || null,
    brand: sorftimeOptionalText(data.brand), buyBoxSeller: sorftimeOptionalText(data.seller_name),
    fulfillment: data.is_fba === true ? 'Amazon 配送（FBA）' : data.is_fba === false ? '卖家自配送（FBM）' : null,
    price: sorftimeOptionalNumber(data.price, { unknownSentinel: true }) || null,
    rating: sorftimeOptionalNumber(data.star_rating, { maximum: 5 }),
    reviews: sorftimeOptionalNumber(data.review_count, { integer: true }),
    launch, variants: variations == null ? null : `${variations}个变体`,
    packageSize: normalizeSorftimePackageSize(data.package_size_cm), packageWeight: weight == null ? null : `${weight} g`,
    fbaFee: sorftimeOptionalNumber(data.fba_fee, { unknownSentinel: true }) || null,
    ...normalizeSorftimeCategories(data, identity.asin),
  };
}
