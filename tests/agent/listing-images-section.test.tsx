import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { refreshedCatalog } from "../../app/competitor-data";
import { getListingImageRemark } from "../../app/listing-image-remarks";
import { ListingImagesSection } from "../../app/listing-images-section";
import { amazonMediaSrc } from "../../app/lib/amazon-image";
import {
  sorftimeListingContentData,
  type SorftimeListingContentRecord,
} from "../../app/sorftime-listing-content-data";

const market = { label: "美国站", domain: "amazon.com" };
const colors = ["#123456"];
const asinWithGallery = "B09ZY6M8XH";
const listingWithGallery = sorftimeListingContentData[asinWithGallery]!;
const catalogWithImage = refreshedCatalog.find(product => product.asin === asinWithGallery)!;

function renderListingImages(product: { asin: string; brand: string; image: string }) {
  return renderToStaticMarkup(
    createElement(ListingImagesSection, { products: [product], market, colors }),
  );
}

function galleryImageSources(html: string) {
  return [...html.matchAll(/<button[^>]*class="listing-image-frame[^>]*><img src="([^"]+)"/g)].map(match => match[1]!);
}

test("Sorftime gallery stays visible without AI remarks and takes priority over the catalog MCP image", () => {
  assert.ok(listingWithGallery.galleryImages.length > 0, "fixture must contain Sorftime gallery images");
  assert.ok(catalogWithImage.image, "fixture must contain a SellerSprite catalog MCP image");
  assert.equal(getListingImageRemark(asinWithGallery, 0), null, "fixture must have no AI remark for the main image");

  const html = renderListingImages({
    asin: asinWithGallery,
    brand: catalogWithImage.brand,
    image: catalogWithImage.image,
  });

  const expectedGallery = listingWithGallery.galleryImages.map(amazonMediaSrc);
  assert.deepEqual(galleryImageSources(html), expectedGallery);
  assert.equal(galleryImageSources(html).includes(amazonMediaSrc(catalogWithImage.image)), false);
  assert.match(html, /AI 备注待后续分析/);
});

test("catalog MCP image renders when the Sorftime record has no gallery", () => {
  const original = sorftimeListingContentData[asinWithGallery]!;
  sorftimeListingContentData[asinWithGallery] = {
    ...original,
    mainImage: null,
    galleryImages: [],
    secondaryImages: [],
    imageCount: 0,
  } satisfies SorftimeListingContentRecord;

  try {
    const html = renderListingImages({
      asin: asinWithGallery,
      brand: catalogWithImage.brand,
      image: catalogWithImage.image,
    });

    assert.deepEqual(galleryImageSources(html), [amazonMediaSrc(catalogWithImage.image)]);
    assert.match(html, /AI 备注待后续分析/);
  } finally {
    sorftimeListingContentData[asinWithGallery] = original;
  }
});

test("renders a truthful no-image state when neither MCP source supplies an image", () => {
  const html = renderListingImages({
    asin: "NO-MCP-IMAGE",
    brand: "No image record",
    image: "",
  });

  assert.deepEqual(galleryImageSources(html), []);
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /暂未返回 Listing 图册或 A\+ 信号/);
});
