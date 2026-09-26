import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {createServer, type ViteDevServer} from "vite";
import type { ExportModuleContext } from "../../app/project-export/export-module-context";
import { readPageSnapshotImages } from "../../app/project-export/read-page-snapshot-images";
import type { PageSnapshotImages as PageSnapshotImagesType } from "../../app/project-export/page-snapshot-images";

let server: ViteDevServer;
let PageSnapshotImages: typeof PageSnapshotImagesType;
before(async () => {
  server = await createServer({configFile: false, server: {middlewareMode: true}, cacheDir: "test-results/page-snapshot-images-vite"});
  ({PageSnapshotImages} = await server.ssrLoadModule("/app/project-export/page-snapshot-images.tsx"));
});
after(async () => {await server?.close();});

const asin = "B000000001";
const other = "B000000002";
const urls = Array.from({length: 11}, (_, index) => `https://m.media-amazon.com/images/I/image${index}.jpg`);
const overlay = {
  asin, index: 2, imageUrl: urls[2], remark: "补充图片二", imageTypes: ["功能展示"], confidence: "high",
  videoThumbnail: false, displayListingStageContentHash: "a".repeat(64),
  source: {sourceKind: "supplemental-analysis", sourceRef: "images/notes.json", sourceArtifactSha256: "a".repeat(64),
    sourceManifestSha256: "b".repeat(64), listingStageContentHash: "a".repeat(64),
    originalJobId: "00000000-0000-4000-8000-000000000001", capturedAt: "2026-09-24T10:00:00.000Z"},
};
function context(options: {gallery?: string[]; remarks?: unknown[]; overlays?: unknown[]; listing?: unknown; marketplace?: string; catalog?: unknown[]} = {}): ExportModuleContext {
  return {projectId: "p", organizationId: "o", marketplace: options.marketplace ?? "US", asins: [asin, other],
    sourceAsins: [asin, other], currentRunId: null, capturedAt: "2026-09-24T10:00:00.000Z",
    version: {marketplace: "US", catalog: options.catalog ?? [{asin, brand: "原厂", image: urls[0]}, {asin: other, brand: "缺图品牌"}],
      imageRemarkOverlay: options.overlays ?? [overlay], stageOutputs: {
        listing: {data: {contentByAsin: {[asin]: options.listing ?? {asin, marketplace: "US", fetchedAt: "2026-09-23", mainImage: urls[0],
          galleryImages: options.gallery ?? urls, previousGalleryImages: urls}}}},
        image_remarks: {data: {remarksByAsin: {[asin]: options.remarks ?? [
          {remark: "旧位置备注", image_types: ["错误"], confidence: "high", imageUrl: urls[3]},
          {remark: "图片二原备注", image_types: ["产品展示", "场景图", "尺寸参数"], confidence: "high", imageUrl: urls[1]},
          null,
          {remark: "图片四完整文字需要原生展开", image_types: ["细节图"], confidence: "medium", imageUrl: urls[3]},
        ]}, outcomesByAsin: {[asin]: [{status: "timeout"}, null, {status: "connector-failed"}]}}},
      }} as never};
}

test("snapshot renders the original matrix with all 11 online images, matched remarks and overlay", () => {
  const source = readPageSnapshotImages(context());
  const html = renderToStaticMarkup(<PageSnapshotImages {...source}/>);
  for (const url of urls) assert.ok(html.includes(`href="${url}"`), url);
  for (const text of ["主辅图横向对比", "图片11", "Sorftime MCP · Provider 返回 11 张", "补充图片二", "图片四完整文字需要原生展开", "功能展示", "补充分析", "缺图品牌", "暂无已保存图片备注"]) assert.ok(html.includes(text), text);
  assert.ok(html.includes("<details"), "long remarks are available in native disclosure");
  assert.doesNotMatch(html, /旧位置备注|生成备注|重新分析|分析待处理|点击再放大|role="dialog"|<button|\/api\/amazon-image/);
  assert.match(html, /background:#2F80ED/);
});

test("previous URL remap binds a legacy remark to the matching current image and rejects stale overlay", () => {
  const reordered = [urls[1], urls[0], urls[2]];
  const source = readPageSnapshotImages(context({gallery: reordered, overlays: [{...overlay, imageUrl: urls[9]}],
    remarks: [{remark: "旧主图文字", image_types: ["旧"], confidence: "high"}, {remark: "重排图文字", image_types: ["新"], confidence: "high"}]}));
  const html = renderToStaticMarkup(<PageSnapshotImages {...source}/>);
  const first = html.indexOf(`href="${urls[1]}"`);
  const second = html.indexOf(`href="${urls[0]}"`);
  assert.ok(first > 0 && second > first);
  assert.ok(html.indexOf("重排图文字", first) < second);
  assert.ok(html.indexOf("旧主图文字", second) > second);
  assert.doesNotMatch(html, /补充图片二/);
});

test("URL-tagged remarks follow reordered images rather than their former slot", () => {
  const source = readPageSnapshotImages(context({gallery: [urls[1], urls[0]], overlays: [],
    remarks: [{remark: "A 标签说明", image_types: ["A"], confidence: "high", imageUrl: urls[0]},
      {remark: "B 标签说明", image_types: ["B"], confidence: "high", imageUrl: urls[1]}]}));
  const html = renderToStaticMarkup(<PageSnapshotImages {...source}/>);
  const first = html.indexOf(`href="${urls[1]}"`), second = html.indexOf(`href="${urls[0]}"`);
  assert.ok(first > 0 && second > first);
  assert.ok(html.indexOf("B 标签说明", first) < second);
  assert.ok(html.indexOf("A 标签说明", second) > second);
  assert.match(html, /已有备注 2\/2 张/);
});

test("snapshot scopes ASIN and site and never falls back to generated global image data", () => {
  assert.throws(() => readPageSnapshotImages(context({listing: {asin: "B000000099", marketplace: "US", galleryImages: urls}})), /来源范围不匹配/);
  assert.throws(() => readPageSnapshotImages(context({listing: {asin, marketplace: "UK", galleryImages: urls}})), /来源范围不匹配/);
  assert.throws(() => readPageSnapshotImages(context({catalog: [{asin, brand: "Bad", marketplace: "UK"}]})), /来源范围不匹配/);
  const empty = context({gallery: []});
  const source = readPageSnapshotImages({...empty, version: null});
  const html = renderToStaticMarkup(<PageSnapshotImages {...source}/>);
  assert.match(html, /暂无已保存商品图数据/);
  assert.doesNotMatch(html, /upstream-empty|分析待处理|Listing 数据采集于 2026-08-13|主款粉色|\/api\//);
});

test("main-image-only remarks obey URL identity and unsafe links remain explained placeholders", () => {
  const mainOnly = readPageSnapshotImages(context({listing: {asin, marketplace: "US", mainImage: urls[0], galleryImages: [],
    previousGalleryImages: [urls[9]]}, overlays: [], remarks: [{remark: "过时图片备注", image_types: ["旧"], confidence: "high"}]}));
  const mainHtml = renderToStaticMarkup(<PageSnapshotImages {...mainOnly}/>);
  assert.ok(mainHtml.includes(`href="${urls[0]}"`));
  assert.doesNotMatch(mainHtml, /过时图片备注/);
  const unsafe = readPageSnapshotImages(context({gallery: ["http://127.0.0.1/private.jpg", urls[1]], overlays: []}));
  const unsafeHtml = renderToStaticMarkup(<PageSnapshotImages {...unsafe}/>);
  assert.match(unsafeHtml, /图片链接不可分享/);
  assert.doesNotMatch(unsafeHtml, /127\.0\.0\.1/);
  assert.ok(unsafeHtml.includes(`href="${urls[1]}"`));
});
