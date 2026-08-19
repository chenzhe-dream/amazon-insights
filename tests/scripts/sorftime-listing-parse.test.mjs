import assert from "node:assert/strict";
import test from "node:test";

import { parseImageList } from "../../scripts/lib/sorftime-listing-parse.mjs";

const images = [
  "https://m.media-amazon.com/images/I/one.jpg",
  "https://m.media-amazon.com/images/I/two.jpg",
  "https://m.media-amazon.com/images/I/three.jpg",
];

test("listing image parser preserves every image in a JSON-string gallery", () => {
  assert.deepEqual(parseImageList(JSON.stringify(images)), images);
});

test("listing image parser retains direct arrays and single legacy URLs", () => {
  assert.deepEqual(parseImageList(images), images);
  assert.deepEqual(parseImageList(images[0]), [images[0]]);
  assert.deepEqual(parseImageList([images[0], "", null, images[1]]), [images[0], images[1]]);
});

test("listing image parser filters non-URL entries from direct and JSON galleries", () => {
  const mixed = [images[0], "not-an-image", " ftp://not-an-image ", "", null, images[1]];
  assert.deepEqual(parseImageList(mixed), [images[0], images[1]]);
  assert.deepEqual(parseImageList(JSON.stringify(mixed)), [images[0], images[1]]);
});

test("listing image parser rejects malformed and non-image scalar payloads", () => {
  assert.deepEqual(parseImageList("[broken"), []);
  assert.deepEqual(parseImageList("not-an-image"), []);
  assert.deepEqual(parseImageList(null), []);
});
