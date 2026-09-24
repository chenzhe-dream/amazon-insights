export const MAX_AMAZON_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export function normalizeImageContentType(raw: string | null) {
  const value = raw?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return IMAGE_TYPES.has(value) ? value : null;
}

export function isValidAmazonImage(bytes: Buffer, contentType: string) {
  if (!IMAGE_TYPES.has(contentType) || bytes.length < 12 || bytes.length > MAX_AMAZON_IMAGE_BYTES) return false;
  switch (contentType) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/webp":
      return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    case "image/gif":
      return bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a";
    case "image/avif":
      return bytes.toString("ascii", 4, 8) === "ftyp" && /^(avif|avis|mif1)$/.test(bytes.toString("ascii", 8, 12));
    default:
      return false;
  }
}
