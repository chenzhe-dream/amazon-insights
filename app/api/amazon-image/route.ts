import { isAmazonImageHost, normalizeAmazonImageUrl } from "../../lib/amazon-image";

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("u");
  if (!raw?.trim()) {
    return new Response("missing url", { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(normalizeAmazonImageUrl(raw));
  } catch {
    return new Response("bad url", { status: 400 });
  }

  if (target.protocol !== "https:" || !isAmazonImageHost(target.hostname)) {
    return new Response("host not allowed", { status: 400 });
  }

  try {
    const upstream = await fetch(target.href, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!upstream.ok) {
      return new Response(`upstream ${upstream.status}`, { status: 502 });
    }
    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return new Response("not an image", { status: 502 });
    }
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "fetch failed", { status: 502 });
  }
}
