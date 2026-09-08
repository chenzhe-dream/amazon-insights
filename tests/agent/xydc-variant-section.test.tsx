import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { XydcVariantSection, groupXydcVariantFamilies } from "../../app/xydc-variant-section";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

const market = { label: "美国站", domain: "www.amazon.com" };
const inputAsins = ["B000000001", "B000000002"];
const fixtureImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect width='72' height='72' fill='%23dbe7f5'/%3E%3C/svg%3E";

function childFixture(index: number): XydcVariantFamily["children"][number] {
  return {
    asin: `B00000${String(index).padStart(4, "0")}`,
    attributes: [{ dimension: "Color", value: `Color ${index}` }],
    title: `Fixture child ${index}`,
    imageUrl: fixtureImage,
    price: 10 + index,
    currency: "USD",
    stars: 4.5,
    productPageRatings: 100 - index,
    listingDate: null,
    infoStatus: "ready",
  };
}

function familyFixture(inputAsin: string, overrides: Partial<XydcVariantFamily> = {}): XydcVariantFamily {
  return {
    inputAsin,
    country: "US",
    parentAsin: "B000000010",
    dimensions: ["Color"],
    children: Array.from({ length: 4 }, (_, index) => childFixture(index + 1)),
    sourceUpdatedAt: "2026-09-04T00:00:00.000Z",
    fetchedAt: "2026-09-04T01:00:00.000Z",
    status: "ready",
    reasonCode: null,
    cacheState: "fresh",
    ...overrides,
  };
}

const products = inputAsins.map((asin, index) => ({
  asin,
  brand: `Brand ${index + 1}`,
  title: `Fixture product ${index + 1}`,
  image: fixtureImage,
}));

function renderSection(families: readonly XydcVariantFamily[], renderedProducts = products) {
  return renderToStaticMarkup(createElement(XydcVariantSection, { products: renderedProducts, families, orderFamilies: [], market }));
}

test("groups matching input ASINs into one parent order card without changing the full child set", () => {
  const families = [familyFixture(inputAsins[0]!), familyFixture(inputAsins[1]!)];
  const grouped = groupXydcVariantFamilies(families);
  const html = renderSection(families);

  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0]?.inputAsins, inputAsins);
  assert.equal(grouped[0]?.children.length, 4);
  assert.equal((html.match(/class="xydc-order-card /g) ?? []).length, 1);
  assert.match(html, /订单数据待采集/);
  assert.match(html, /已识别 4 个子体/);
  assert.match(html, /查看全部 4 个子体/);
  assert.doesNotMatch(html, /查看全部 4 个子体与月度趋势/);
});

test("preserves input order for cards and representative catalog products", () => {
  const reversedProducts = [products[1]!, products[0]!];
  const merged = [
    familyFixture(inputAsins[0]!, { parentAsin: "B000000099" }),
    familyFixture(inputAsins[1]!, { parentAsin: "B000000099" }),
  ];
  const laterInput = familyFixture(inputAsins[0]!, { parentAsin: "B000000010" });
  const html = renderSection([...merged, laterInput], reversedProducts);
  const cards = html.match(/<article class="xydc-order-card[\s\S]*?<\/article>/g) ?? [];

  assert.equal(cards.length, 2);
  assert.match(cards[0]!, /B000000099/);
  assert.match(cards[0]!, /竞品 1/);
  assert.match(cards[0]!, /Brand 2/);
  assert.match(cards[1]!, /B000000010/);
  assert.match(cards[1]!, /竞品 2/);
  assert.match(cards[1]!, /Brand 1/);
});

test("merges duplicate children deterministically without incomplete data replacing ready data", () => {
  const ready = familyFixture(inputAsins[0]!, {
    sourceUpdatedAt: "2026-09-02T00:00:00.000Z",
    children: [{ ...childFixture(1), title: "Ready child", infoStatus: "ready", price: 12 }],
  });
  const pendingNewer = familyFixture(inputAsins[1]!, {
    sourceUpdatedAt: "2026-09-03T00:00:00.000Z",
    children: [{ ...childFixture(1), title: "Pending child", infoStatus: "pending", price: null }],
  });
  const pendingOlder = familyFixture("B000000003", {
    sourceUpdatedAt: "2026-09-01T00:00:00.000Z",
    children: [{ ...childFixture(2), title: "Old pending child", infoStatus: "pending" }],
  });
  const pendingNewerSameTier = familyFixture("B000000004", {
    sourceUpdatedAt: "2026-09-04T00:00:00.000Z",
    children: [{ ...childFixture(2), title: "New pending child", infoStatus: "pending" }],
  });

  const forward = groupXydcVariantFamilies([ready, pendingNewer, pendingOlder, pendingNewerSameTier]);
  const reverse = groupXydcVariantFamilies([pendingNewerSameTier, pendingOlder, pendingNewer, ready]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward[0]?.children.find(child => child.asin === childFixture(1).asin)?.title, "Ready child");
  assert.equal(forward[0]?.children.find(child => child.asin === childFixture(2).asin)?.title, "New pending child");
});

test("keeps catalog placeholders, variant source timestamps, and Chinese variant failures visible", () => {
  const reasonCases: Array<[XydcVariantFamily["reasonCode"], string]> = [
    ["NOT_CONFIGURED", "西柚数据源未配置"],
    ["AUTH_FAILED", "西柚数据源认证失败"],
    ["TIMEOUT", "西柚请求超时"],
    ["RPC_ERROR", "西柚服务暂不可用"],
    ["SCHEMA_INVALID", "数据源返回格式异常"],
    ["NOT_FOUND", "数据源未返回该商品变体"],
    ["PARTIAL_CHILD_INFO", "部分子体详情暂未返回"],
    [null, "数据源未返回具体原因"],
  ];
  const families = reasonCases.map(([reasonCode], index) => familyFixture(`B${String(10_000_000 + index).padStart(9, "0")}`, {
    parentAsin: `B${String(20_000_000 + index).padStart(9, "0")}`,
    status: "unavailable",
    reasonCode,
    children: [],
  }));
  const html = renderSection(families, [{ ...products[0]!, asin: families[0]!.inputAsin, brand: "等待同步", title: "等待卖家精灵与 SIF MCP 返回商品数据" }]);

  assert.match(html, /品牌资料待补充/);
  assert.match(html, /商品资料待补充，不影响已获取的变体展示/);
  assert.match(html, /变体来源更新时间：2026-09-04T00:00:00.000Z/);
  assert.match(html, /变体采集时间：2026-09-04T01:00:00.000Z/);
  for (const [, label] of reasonCases) assert.match(html, new RegExp(label));
});

test("uses ordinary Amazon links with safe new-tab attributes", () => {
  const html = renderSection([familyFixture(inputAsins[0]!)]);
  const parentLink = html.match(/<a[^>]+href="https:\/\/www\.amazon\.com\/dp\/B000000010"[^>]*>/)?.[0] ?? "";

  assert.match(parentLink, /target="_blank"/);
  assert.match(parentLink, /rel="noopener noreferrer"/);
  assert.doesNotMatch(parentLink, /javascript:|onClick/);
});
