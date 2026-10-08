import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("server-renders the authentication checking shell without protected navigation", async () => {
  const response = await render();
  const html = await response.text();
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? "";

  assert.match(body, /正在检查登录状态/);
  for (const label of ["竞品概览", "VOC", "关键词调研", "新品定义", "立项前确认清单", "竞品流量分析", "收藏夹"]) {
    assert.doesNotMatch(body, new RegExp(label));
  }
  assert.doesNotMatch(body, /auth-modal-backdrop|role=["']dialog["']|name=["']currentPassword["']/);
});

test("removes redundant A+ and standalone VOC entry points while retaining manual VOC inputs", () => {
  const pageSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(pageSource, /overview-aplus/);
  assert.doesNotMatch(pageSource, /高级 A\+/);
  assert.doesNotMatch(pageSource, /参数 · 主辅图 · A\+/);
  assert.doesNotMatch(pageSource, /VOC 独立分析/);
  assert.doesNotMatch(pageSource, /开始 VOC 独立分析/);
  assert.match(pageSource, /AlexaVocImportPanel/);
  assert.match(pageSource, /ManualVocMatrixSection/);

  const importPanelSource = readFileSync(new URL("../app/alexa-voc-import-panel.tsx", import.meta.url), "utf8");
  assert.match(importPanelSource, /Alexa 七问 · 快速录入/);
});
