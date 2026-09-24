import assert from "node:assert/strict";
import { test } from "node:test";
import type { PreparedExportContent, ExportBlock } from "../../app/project-export/export-contracts";

// Keep missing-feature failures as assertions during the initial TDD run.
const renderer = await import("../../app/project-export/render-export-html").catch(() => null);
const downloader = await import("../../app/project-export/download-export-html").catch(() => null);
function render(content: PreparedExportContent): string {
  assert.ok(renderer, "Static HTML renderer must be implemented");
  return renderer.renderExportHtml(content);
}
function content(blocks: readonly ExportBlock[] = []): PreparedExportContent {
  return { schemaVersion: "1", project: { id: "p1", name: "灯具项目", marketplace: "US", asins: ["B000000001", "B000000002"] }, capturedAt: "2026-09-24T16:02:03Z", sourceLabel: "已发布版本 v1（来源更新于 2026-09-20）", sections: [{ id: "competitor-overview", title: "竞品参数总览", status: "ready", blocks }] };
}

test("standalone report preserves all 100 rows, Unicode and complete details", () => {
  const html = render(content([
    { kind: "text", text: "完整说明\n第二段：中文与 emoji 💡" },
    { kind: "table", title: "完整参数", columns: ["产品", "详情"], rows: Array.from({ length: 100 }, (_, i) => [{ text: `产品-${i + 1}` }, { text: `完整详情-${i + 1}` }]) },
  ]));
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta charset="utf-8"/i);
  assert.match(html, /<style>[\s\S]+<\/style>/);
  assert.match(html, /完整说明\n第二段：中文与 emoji 💡/);
  for (let i = 1; i <= 100; i++) {
    assert.ok(html.includes(`>产品-${i}<`));
    assert.ok(html.includes(`>完整详情-${i}<`));
  }
  assert.match(html, /B000000001/);
  assert.match(html, /B000000002/);
  assert.match(html, /快照准备完成时间/);
  assert.match(html, /2026-09-25 00:02:03/);
  assert.match(html, /来源更新于 2026-09-20/);
});

test("all text contexts are escaped and no executable or application payload is emitted", () => {
  const attack = '</title><script>alert("x")</script><img src=x onerror="bad()"> & \'输入\'';
  const data = content([{ kind: "table", title: attack, columns: [attack], rows: [[{ text: attack }]] }, { kind: "text", text: attack }, { kind: "chart", title: attack, labels: [attack], series: [{ label: attack, values: [2] }] }]);
  data.project.name = attack;
  data.sourceLabel = attack;
  data.sections = [{ ...data.sections[0], title: attack }];
  const html = render(data);
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.doesNotMatch(html, /<script|<iframe|<form|<link|<img src=x|application\/json|\/api\//i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /img-src https:/);
});

test("renderer only emits prepared selected sections, never other module catalog or hidden data", () => {
  const html = render(content([{ kind: "text", text: "只选概览" }]));
  assert.match(html, /只选概览/);
  assert.doesNotMatch(html, /VOC|关键词调研|新品定义|variants-orders|listing-images|application\/json/);
});

test("missing module retains a clear missing status and supplied source limitation", () => {
  const data = content();
  data.sections = [{ id: "competitor-overview", title: "竞品参数总览", status: "missing", blocks: [{ kind: "text", text: "来源仅提供 Top 10；未生成其余结果" }] }];
  const html = render(data);
  assert.match(html, /暂无已生成结果/);
  assert.match(html, /来源仅提供 Top 10/);
});

test("static charts preserve gaps, zero, every label and every series value", () => {
  const html = render(content([{ kind: "chart", title: "销售趋势", labels: ["一月", "二月", "三月", "四月", "五月"], series: [{ label: "产品 A", values: [12, null, 0, 8, 9] }, { label: "产品 B", values: [3, 2, 1, null, 4] }] }]));
  assert.match(html, /<svg/);
  assert.match(html, /<td>一月<\/td><td>12<\/td><td>3<\/td>/);
  assert.match(html, /<td>二月<\/td><td>—<\/td><td>2<\/td>/);
  assert.match(html, /<td>三月<\/td><td>0<\/td><td>1<\/td>/);
  assert.match(html, /<td>四月<\/td><td>8<\/td><td>—<\/td>/);
  assert.match(html, /<td>五月<\/td><td>9<\/td><td>4<\/td>/);
  assert.match(html, /缺失值以 — 表示/);
  // Two disjoint runs per series; never connect across a missing observation.
  assert.equal((html.match(/<polyline /g) ?? []).length, 2);
  assert.equal((html.match(/<circle /g) ?? []).length, 8);
});

test("empty and entirely missing charts do not fabricate zero values", () => {
  const html = render(content([{ kind: "chart", title: "无系列", labels: ["一月"], series: [] }, { kind: "chart", title: "无数值", labels: ["二月"], series: [{ label: "销量", values: [null] }] }]));
  assert.doesNotMatch(html, /<svg|<td>0<\/td>/);
  assert.match(html, /暂无可用图表数据/);
  assert.match(html, /<td>二月<\/td><td>—<\/td>/);
});

test("online images unwrap only the known relative proxy and include alt and original link", () => {
  const original = "https://m.media-amazon.com/images/I/example.jpg?a=1&b=2";
  const html = render(content([{ kind: "table", title: "图片", columns: ["产品"], rows: [[{ text: '灯具 "正面"', imageUrl: `/api/amazon-image?u=${encodeURIComponent(original)}`, href: "https://www.amazon.com/dp/B000000001" }]] }]));
  assert.match(html, /src="https:\/\/m.media-amazon.com\/images\/I\/example.jpg\?a=1&amp;b=2"/);
  assert.match(html, /alt="灯具 &quot;正面&quot;"/);
  assert.match(html, />查看原图<\/a>/);
  assert.match(html, /href="https:\/\/www.amazon.com\/dp\/B000000001"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.match(html, /图片.*在线/);
  assert.doesNotMatch(html, /\/api\/amazon-image|data:image/);
});

test("unsafe URLs, local hosts, private IP literals, credentials and unknown proxies are not exported", () => {
  const unsafe = ["javascript:alert(1)", "data:image/svg+xml,x", "http://m.media-amazon.com/a.jpg", "https://user:secret@example.com/a", "https://localhost/a", "https://localhost./a", "https://x.localhost/a", "https://printer.local/a", "https://intranet/a", "https://127.0.0.1/a", "https://2130706433/a", "https://10.1.2.3/a", "https://172.16.0.1/a", "https://192.168.1.1/a", "https://169.254.1.1/a", "https://100.64.0.1/a", "https://0.0.0.0/a", "https://[::1]/a", "https://[fc00::1]/a", "https://[fe80::1]/a", "https://[::ffff:127.0.0.1]/a", "//example.com/a.jpg", "/relative.jpg", "/api/unknown?u=https%3A%2F%2Fexample.com%2Fa.jpg", "/api/amazon-image?u=https%3A%2F%2F127.0.0.1%2Fa", "/api/amazon-image?u=https%3A%2F%2Fexample.com%2Fa&extra=1", "https://example.com/a?access_token=secret", "https://example.com/a?X-Amz-Signature=secret"];
  for (const imageUrl of unsafe) {
    const html = render(content([{ kind: "table", title: "图片", columns: ["产品"], rows: [[{ text: "描述保留", imageUrl, href: imageUrl }]] }]));
    assert.doesNotMatch(html, /<img|<a /, imageUrl);
    assert.match(html, /描述保留/);
    assert.match(html, /无可分享图片地址/);
  }
});

test("chart variant colors stay consistent and cannot inject CSS or SVG", () => {
  const html=render(content([{kind:"chart",title:"颜色",labels:["一月","二月"],series:[
    {label:"浅蓝",color:"#12abcd",values:[1,2]},
    {label:"恶意来源",color:'red"><script>bad()</script>',values:[3,4]},
  ]}]));
  assert.match(html,/stroke="#12abcd"/);assert.match(html,/border-color:#12abcd/);
  assert.doesNotMatch(html,/<script>|bad\(\)/);
});

test("filenames use Beijing time, preserve Unicode and remain safe and bounded on Windows", () => {
  assert.ok(downloader, "HTML download module must be implemented");
  assert.equal(downloader.buildExportFileName("灯具 💡", "US", "2026-09-24T16:02:03Z"), "灯具 💡_US_快照_20260925-000203.html");
  const name = downloader.buildExportFileName('CON<>:"/\\|?*\u0000. ', "US:/", "2026-09-24T16:02:03Z");
  assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f]/);
  assert.ok(name.endsWith("_快照_20260925-000203.html"));
  const long = downloader.buildExportFileName("💡".repeat(300), "M".repeat(300), "2026-09-24T16:02:03Z");
  assert.ok(long.length <= 140);
  assert.doesNotMatch(long, /\ud800(?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  assert.throws(() => downloader.buildExportFileName("项目", "US", "invalid"), /时间|date/i);
});

test("download uses the exact supplied UTF-8 HTML and cleans up after initiating it", async t => {
  assert.ok(downloader, "HTML download module must be implemented");
  let capturedBlob: Blob | undefined;
  const events: string[] = [];
  const anchor = { href: "", download: "", style: { display: "" }, click: () => events.push("click"), remove: () => events.push("remove") };
  t.mock.method(URL, "createObjectURL", (blob: Blob) => { capturedBlob = blob; events.push("create"); return "blob:fixed-snapshot"; });
  t.mock.method(URL, "revokeObjectURL", (url: string) => { assert.equal(url, "blob:fixed-snapshot"); events.push("revoke"); });
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag: string) => { assert.equal(tag, "a"); return anchor; }, body: { appendChild: () => events.push("append") } } });
  t.after(() => { if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document"); });
  let deferred: (() => void) | undefined;
  t.mock.method(globalThis, "setTimeout", (fn: () => void) => { deferred = fn; return 0; });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Download must not fetch"); });
  const html = "<!doctype html><p>预览固定正文 💡</p>";
  downloader.downloadExportHtml(html, "固定.html");
  assert.equal(capturedBlob?.type, "text/html;charset=utf-8");
  assert.equal(await capturedBlob?.text(), html);
  assert.equal(anchor.href, "blob:fixed-snapshot");
  assert.equal(anchor.download, "固定.html");
  assert.deepEqual(events, ["create", "append", "click", "remove"]);
  assert.ok(deferred);
  deferred();
  assert.equal(events.at(-1), "revoke");
});
