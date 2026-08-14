import assert from "node:assert/strict";
import test from "node:test";

const description = "面向亚马逊运营团队的产品机会洞察：竞品对比、VOC、流量、关键词与立项决策。";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Amazon application metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Amazon 产品机会洞察<\/title>/);
  assert.match(
    html,
    new RegExp(`<meta(?=[^>]*\\bname=["']description["'])(?=[^>]*\\bcontent=["']${description}["'])[^>]*>`, "i"),
  );
});

test("server-renders the Amazon brand shell and primary navigation", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /<img(?=[^>]*\bsrc=["']\/amazon-logo\.svg["'])(?=[^>]*\balt=["']Amazon["'])[^>]*>/i);
  assert.match(html, /产品机会洞察/);
  for (const label of ["竞品概览", "VOC", "关键词调研", "新品定义", "立项前确认清单", "竞品流量分析", "收藏夹"]) {
    assert.match(html, new RegExp(label));
  }
});
