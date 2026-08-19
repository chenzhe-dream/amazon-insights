import assert from "node:assert/strict";
import test from "node:test";

import { localAgentFetch } from "../../app/lib/local-agent-browser";

test("local Agent browser fetch routes through the same-origin proxy without public secrets", async () => {
  const calls: Array<{ input: string; headers: Headers; body: BodyInit | null | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      input: String(input),
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    await localAgentFetch("/v1/local-voc", {
      method: "POST",
      body: JSON.stringify({ asins: ["B07VY9Q95Q", "B0BPXRVWYK", "B07DYG1C9B"], marketplace: "US" }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/agent/v1/local-voc");
  assert.equal(calls[0]?.headers.get("x-agent-proxy-token"), null);
  assert.equal(calls[0]?.headers.get("content-type"), "application/json");
});

test("local Agent browser fetch preserves query strings on the same-origin proxy path", async () => {
  let observedInput = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    observedInput = String(input);
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    await localAgentFetch("/v1/local-data/projects?kind=analysis");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(observedInput, "/api/agent/v1/local-data/projects?kind=analysis");
});
