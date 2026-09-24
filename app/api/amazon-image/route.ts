import { isAmazonImageHost, normalizeAmazonImageUrl } from "../../lib/amazon-image";
import { MAX_AMAZON_IMAGE_BYTES, isValidAmazonImage, normalizeImageContentType } from "../../lib/amazon-image-validation.server";

const MAX_IMAGE_URL_LENGTH = 4096;
export const dynamic = "force-dynamic";

function imageResponse(bytes: Buffer, contentType: string) {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function boundedImageBody(upstream: Response) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("empty image body");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AMAZON_IMAGE_BYTES) throw new Error("image too large");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("u");
  if (!raw?.trim()) {
    return new Response("missing url", { status: 400 });
  }
  if (raw.length > MAX_IMAGE_URL_LENGTH) return new Response("bad url", { status: 400 });

  let target: URL;
  try {
    target = new URL(normalizeAmazonImageUrl(raw));
  } catch {
    return new Response("bad url", { status: 400 });
  }

  if (target.protocol !== "https:" || !isAmazonImageHost(target.hostname) ||
      target.username || target.password || target.port || !target.pathname.startsWith("/images/")) {
    return new Response("host not allowed", { status: 400 });
  }
  target.hash = "";

  try {
    const upstream = await fetch(target.href, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (upstream.status !== 200) {
      return new Response(`upstream ${upstream.status}`, { status: 502 });
    }
    const contentType = normalizeImageContentType(upstream.headers.get("content-type"));
    const declaredLength = Number(upstream.headers.get("content-length"));
    if (!contentType || (upstream.headers.has("content-length") &&
      (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_AMAZON_IMAGE_BYTES))) {
      return new Response("not an image", { status: 502 });
    }
    const bytes = await boundedImageBody(upstream);
    if (!isValidAmazonImage(bytes, contentType)) return new Response("not an image", { status: 502 });
    return imageResponse(bytes, contentType);
  } catch {
    return new Response("image unavailable", { status: 502 });
  }
}
