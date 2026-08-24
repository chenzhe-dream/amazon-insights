import assert from "node:assert/strict";
import test from "node:test";

import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ListingImagesSection } from "../../app/listing-images-section";
import { amazonMediaSrc } from "../../app/lib/amazon-image";
import type { SorftimeListingContentRecord } from "../../app/sorftime-listing-content-data";

const market = { label: "美国站", domain: "amazon.com" };
const colors = ["#123456"];
const fixtureAsin = "B07VY9Q95Q";
const sorftimeMainImage = "https://m.media-amazon.com/images/I/81sHDISn2bL.jpg";
const sorftimeSecondaryImage = "https://m.media-amazon.com/images/I/81f6K8vA1LL.jpg";
const sellerSpriteCatalogImage = "https://m.media-amazon.com/images/I/712PF4pUZ9L._AC_SL1500_.jpg";

function listingFixture(overrides: Partial<SorftimeListingContentRecord> = {}): SorftimeListingContentRecord {
  return {
    asin: fixtureAsin,
    marketplace: "US",
    fetchedAt: "2026-08-11",
    status: "ready",
    mainImage: sorftimeMainImage,
    galleryImages: [sorftimeMainImage, sorftimeSecondaryImage],
    secondaryImages: [sorftimeSecondaryImage],
    imageCount: 2,
    hasAplus: true,
    hasEbc: true,
    hasVideo: false,
    lqs: 100,
    ...overrides,
  };
}

type ListingImagesProps = ComponentProps<typeof ListingImagesSection> & {
  listingByAsin: Readonly<Record<string, SorftimeListingContentRecord>>;
  resolveImageRemark: () => null;
};

function renderListingImages(
  product: { asin: string; brand: string; image: string },
  listing: SorftimeListingContentRecord,
) {
  const props: ListingImagesProps = {
    products: [product],
    market,
    colors,
    listingByAsin: { [product.asin]: listing },
    resolveImageRemark: () => null,
  };
  return renderToStaticMarkup(createElement(ListingImagesSection, props));
}

function galleryImageSources(html: string) {
  return [...html.matchAll(/<button[^>]*class="listing-image-frame[^>]*><img src="([^"]+)"/g)].map(match => match[1]!);
}

test("injected Sorftime gallery stays visible without AI remarks and takes priority over the catalog MCP image", () => {
  const html = renderListingImages(
    { asin: fixtureAsin, brand: "Fixture brand", image: sellerSpriteCatalogImage },
    listingFixture(),
  );

  assert.deepEqual(galleryImageSources(html), [sorftimeMainImage, sorftimeSecondaryImage].map(amazonMediaSrc));
  assert.equal(galleryImageSources(html).includes(amazonMediaSrc(sellerSpriteCatalogImage)), false);
  assert.match(html, /Sorftime MCP · 图册 2 张/);
  assert.match(html, /AI 备注待后续分析/);
});

test("injected catalog MCP fallback renders with SellerSprite provenance and a non-empty state", () => {
  const html = renderListingImages(
    { asin: fixtureAsin, brand: "Fixture brand", image: sellerSpriteCatalogImage },
    listingFixture({
      mainImage: null,
      galleryImages: [],
      secondaryImages: [],
      imageCount: 0,
      hasAplus: false,
    }),
  );

  assert.deepEqual(galleryImageSources(html), [amazonMediaSrc(sellerSpriteCatalogImage)]);
  assert.match(html, /SellerSprite MCP · 商品图 1 张/);
  assert.doesNotMatch(html, /图册已从 Sorftime 拉回/);
  assert.match(html, /AI 备注待后续分析/);
});

test("injected empty MCP sources render a truthful no-image state without claiming a pull succeeded", () => {
  const html = renderListingImages(
    { asin: fixtureAsin, brand: "Fixture brand", image: "" },
    listingFixture({
      status: "empty",
      mainImage: null,
      galleryImages: [],
      secondaryImages: [],
      imageCount: 0,
      hasAplus: null,
    }),
  );

  assert.deepEqual(galleryImageSources(html), []);
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /MCP 暂未返回商品图/);
  assert.doesNotMatch(html, /已从.+拉回/);
});
