const imageUrl = (value) => typeof value === 'string' ? value.trim() : '';

/** Preserve remarks only for unambiguous exact image identities within this call. */
export function reconcileListingImageRemarks(previousUrls, nextUrls, previousRemarks) {
  const oldUrls = Array.isArray(previousUrls) ? previousUrls : [];
  const newUrls = Array.isArray(nextUrls) ? nextUrls : [];
  const remarks = Array.isArray(previousRemarks) ? previousRemarks : [];
  const byUrl = new Map();

  for (let index = 0; index < oldUrls.length; index += 1) {
    const url = imageUrl(oldUrls[index]);
    if (!url) continue;
    byUrl.set(url, byUrl.has(url) ? null : remarks[index] ?? null);
  }

  return Array.from(newUrls, (value) => byUrl.get(imageUrl(value)) ?? null);
}
