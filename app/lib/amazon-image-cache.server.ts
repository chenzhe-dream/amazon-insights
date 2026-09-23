import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const MAX_AMAZON_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_AMAZON_IMAGE_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export type CachedAmazonImage = Readonly<{ bytes: Buffer; contentType: string }>;

type ImageManifest = {
  urlHash: string;
  contentHash: string;
  contentType: string;
  byteLength: number;
  storedAt: string;
};

function sha256(input: string | Buffer) {
  return createHash("sha256").update(input).digest("hex");
}

function cacheRoot() {
  const configured = process.env.AGENT_DATA_ROOT?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("AGENT_DATA_ROOT must be absolute");
    return path.join(configured, "amazon-image-cache", "v1");
  }
  if (process.env.AGENT_FORMAL_WORKTREE_ROOT) throw new Error("AGENT_DATA_ROOT is required in formal mode");
  return path.join(homedir(), ".cache", "amazon-product-opportunity-insights", "amazon-image-cache", "v1");
}

function pathsFor(url: string, contentHash?: string) {
  const root = cacheRoot();
  const urlHash = sha256(url);
  return {
    urlHash,
    manifest: path.join(root, "urls", urlHash.slice(0, 2), `${urlHash}.json`),
    blob: contentHash ? path.join(root, "blobs", contentHash.slice(0, 2), contentHash) : null,
  };
}

function isImageSignature(bytes: Buffer, contentType: string) {
  if (!IMAGE_TYPES.has(contentType) || bytes.length < 12) return false;
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

export function normalizeImageContentType(raw: string | null) {
  const value = raw?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return IMAGE_TYPES.has(value) ? value : null;
}

export function isValidAmazonImage(bytes: Buffer, contentType: string) {
  return bytes.length > 0 && bytes.length <= MAX_AMAZON_IMAGE_BYTES && isImageSignature(bytes, contentType);
}

export async function readCachedAmazonImage(url: string): Promise<CachedAmazonImage | null> {
  try {
    const { urlHash, manifest: manifestPath } = pathsFor(url);
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) return null;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageManifest;
    if (manifest.urlHash !== urlHash || !/^[a-f0-9]{64}$/.test(manifest.contentHash) ||
        !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 1 ||
        manifest.byteLength > MAX_AMAZON_IMAGE_BYTES || !IMAGE_TYPES.has(manifest.contentType)) return null;
    const blobPath = pathsFor(url, manifest.contentHash).blob!;
    const blobStat = await lstat(blobPath);
    if (!blobStat.isFile() || blobStat.size !== manifest.byteLength) return null;
    const bytes = await readFile(blobPath);
    if (sha256(bytes) !== manifest.contentHash || !isValidAmazonImage(bytes, manifest.contentType)) return null;
    return { bytes, contentType: manifest.contentType };
  } catch {
    return null;
  }
}

async function writeAtomically(destination: string, bytes: Buffer | string) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function blobUsageBytes(root: string) {
  const directory = path.join(root, "blobs");
  let shards;
  try { shards = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    for (const file of await readdir(path.join(directory, shard.name), { withFileTypes: true })) {
      if (!file.isFile()) continue;
      total += (await lstat(path.join(directory, shard.name, file.name))).size;
    }
  }
  return total;
}

export async function storeCachedAmazonImage(
  url: string,
  image: CachedAmazonImage,
  { maxTotalBytes = MAX_AMAZON_IMAGE_CACHE_BYTES }: { maxTotalBytes?: number } = {},
) {
  if (!isValidAmazonImage(image.bytes, image.contentType)) throw new Error("Invalid image bytes");
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error("Invalid cache capacity");
  const contentHash = sha256(image.bytes);
  const { urlHash, manifest, blob } = pathsFor(url, contentHash);
  let existingBytes = 0;
  try {
    const existing = await lstat(blob!);
    if (!existing.isFile()) throw new Error("Invalid cached blob");
    existingBytes = existing.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if ((await blobUsageBytes(cacheRoot())) - existingBytes + image.bytes.length > maxTotalBytes) {
    throw new Error("Amazon image cache capacity exceeded");
  }
  await writeAtomically(blob!, image.bytes);
  const record: ImageManifest = {
    urlHash,
    contentHash,
    contentType: image.contentType,
    byteLength: image.bytes.length,
    storedAt: new Date().toISOString(),
  };
  await writeAtomically(manifest, JSON.stringify(record));
}
