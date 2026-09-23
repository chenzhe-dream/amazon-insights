/** Keep legacy remarks attached to their old URL until the refreshed remarks arrive. */
export function resolveRemarkForGalleryImage<T extends object>(
  imageUrl: string,
  slotIndex: number,
  previousUrls: readonly string[] | undefined,
  readRemark: (index: number) => T | null,
): T | null {
  const current = readRemark(slotIndex);
  if (current && "imageUrl" in current) return current.imageUrl === imageUrl ? current : null;
  if (!previousUrls?.length) return current;
  const matches = previousUrls.flatMap((url, index) => url.trim() === imageUrl.trim() ? [index] : []);
  if (matches.length !== 1) return null;
  const previous = readRemark(matches[0]);
  return previous && "imageUrl" in previous && previous.imageUrl !== imageUrl ? null : previous;
}
