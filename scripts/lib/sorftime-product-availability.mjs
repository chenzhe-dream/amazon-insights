// Sorftime GB product_detail has returned this exact synthetic #ASIN shape for
// unavailable products. Match the complete observed shape, including placeholder
// numbers, so partial or changed provider data remains subject to normal checks.
const nullFields = ['parent_asin','title','sub_title','brand','store_name','seller_name','seller_id',
  'category','sub_category','online_date','listing_date','ships_from','seller_country','extra_savings',
  'peak_season','package_size_cm'];
const zeroFields = ['days_on_shelf','price','list_price','coupon','star_rating','review_count',
  'monthly_sales_volume','monthly_sales_amount','yearly_sales_volume','fba_fee','ship_cost','platform_fee',
  'profit','profit_rate','seller_count','variation_count','weight_g'];
const falseFields = ['a_plus','has_video','has_brand_store','is_fba'];

export function isExactMissingProductDetail(raw, asin) {
  const data = raw?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.asin !== `#${asin}`) return false;
  const expectedCount = 1 + nullFields.length + zeroFields.length + falseFields.length;
  return Object.keys(data).length === expectedCount &&
    nullFields.every(field => Object.hasOwn(data,field) && data[field] === null) &&
    zeroFields.every(field => Object.hasOwn(data,field) && data[field] === 0) &&
    falseFields.every(field => Object.hasOwn(data,field) && data[field] === false);
}
