import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GET } from "../../app/api/amazon-image/route";
import { amazonMediaSrc } from "../../app/lib/amazon-image";

const SOURCE = "https://m.media-amazon.com/images/I/51T6x9KgnAL.jpg";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9fQAAAAASUVORK5CYII=",
  "base64",
);

function request(url = SOURCE, cookie?: string) {
  return new Request(`http://localhost/api/amazon-image?u=${encodeURIComponent(url)}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

function pngResponse(body: Uint8Array = PNG, headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(body), { headers: { "Content-Type": "image/png", ...headers } });
}

test("image proxy fetches the stored URL without persisting image bytes", async () => {
  await withTempDataRoot(async (root, setFetch) => {
    let calls = 0;
    setFetch(async () => { calls++; return pngResponse(); });
    const first = await GET(request());
    const second = await GET(request());
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(calls, 2, "each request must use the URL, not a server disk copy");
    assert.deepEqual(await readdir(root), []);
  });
});

async function withTempDataRoot(run: (root: string, setFetch: (fetcher: typeof fetch) => void) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "amazon-image-proxy-test-"));
  const oldRoot = process.env.AGENT_DATA_ROOT;
  const oldFetch = globalThis.fetch;
  process.env.AGENT_DATA_ROOT = root;
  try {
    await run(root, fetcher => { globalThis.fetch = fetcher; });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldRoot === undefined) delete process.env.AGENT_DATA_ROOT;
    else process.env.AGENT_DATA_ROOT = oldRoot;
    await rm(root, { recursive: true, force: true });
  }
}

test("unavailable source returns an error because no image bytes are stored", async () => {
  await withTempDataRoot(async (_root, setFetch) => {
    let calls = 0;
    setFetch(async () => { calls++; return pngResponse(); });
    const first = await GET(request());
    assert.equal(first.status, 200);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), PNG);
    setFetch(async () => { calls++; throw new Error("offline"); });
    const second = await GET(request(SOURCE, "session=unrelated"));
    assert.equal(second.status, 502);
    assert.equal(calls, 2);
  });
});

test("proxy rejects oversized, disguised, or active image content", async () => {
  await withTempDataRoot(async (_root, setFetch) => {
    setFetch(async () => pngResponse(PNG, { "Content-Length": String(9 * 1024 * 1024) }));
    assert.equal((await GET(request())).status, 502);

    setFetch(async () => new Response("<svg onload=alert(1) />", { headers: { "Content-Type": "image/svg+xml" } }));
    assert.equal((await GET(request())).status, 502);

    setFetch(async () => pngResponse(Buffer.from("not actually a png")));
    assert.equal((await GET(request())).status, 502);

    const oversized = Buffer.alloc(9 * 1024 * 1024);
    PNG.copy(oversized);
    setFetch(async () => pngResponse(oversized, { "Content-Length": "64" }));
    assert.equal((await GET(request())).status, 502, "actual body size must be bounded even when the header lies");
  });
});

test("proxy disallows redirects and non Amazon targets", async () => {
  await withTempDataRoot(async (_root, setFetch) => {
    setFetch(async (_url, options) => {
      assert.equal(options?.redirect, "error");
      assert.equal(options?.cache, "no-store");
      return pngResponse();
    });
    assert.equal((await GET(request("https://127.0.0.1/images/I/x.jpg"))).status, 400);
    assert.equal((await GET(request("https://m.media-amazon.com:8443/images/I/x.jpg"))).status, 400);
    assert.equal((await GET(request("https://user:pass@m.media-amazon.com/images/I/x.jpg"))).status, 400);
    assert.equal((await GET(request())).status, 200);
  });
});

test("Amazon image helper uses same-origin proxy while other URLs retain existing behavior", () => {
  assert.equal(amazonMediaSrc(SOURCE), `/api/amazon-image?u=${encodeURIComponent(SOURCE)}`);
  assert.equal(amazonMediaSrc("https://images.example.com/a.png"), "https://images.example.com/a.png");
  assert.equal(amazonMediaSrc("http://m.media-amazon.com/images/I/x.jpg"), "");
});
