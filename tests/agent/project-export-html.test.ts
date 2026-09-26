import assert from "node:assert/strict";
import { test } from "node:test";
import * as downloader from "../../app/project-export/download-export-html";

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
