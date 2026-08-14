const AMAZON_IMAGE_HOSTS = new Set([
  "m.media-amazon.com",
  "images-na.ssl-images-amazon.com",
  "images-eu.ssl-images-amazon.com",
  "images-fe.ssl-images-amazon.com",
]);

export function isAmazonImageHost(hostname: string) {
  return AMAZON_IMAGE_HOSTS.has(hostname) || hostname.endsWith(".media-amazon.com");
}

/** 卖家精灵 zoom 图常用 _AC_SR600,600_，逗号在部分浏览器/代理下会加载失败 */
export function normalizeAmazonImageUrl(url: string) {
  return String(url ?? "")
    .trim()
    .replace(/_AC_SR\d+,\d+_/g, "_AC_US600_");
}

export function amazonMediaSrc(url?: string | null) {
  const normalized = normalizeAmazonImageUrl(url ?? "");
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (!isAmazonImageHost(parsed.hostname)) return normalized;
  } catch {
    return "";
  }
  return `/api/amazon-image?u=${encodeURIComponent(normalized)}`;
}
