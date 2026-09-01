import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildListingRecordFromProductDetailEvidence,
  discardUnscopedListingRecord,
  parseImageList,
  selectScopedListingRecord,
} from "../../scripts/lib/sorftime-listing-parse.mjs";
import {
  createProductDetailEvidence,
  readScopedSorftimeEvidence,
  writeScopedSorftimeEvidence,
} from "../../scripts/lib/scoped-sorftime-evidence.mjs";
import { runImageRemarkQueue } from "../../scripts/lib/image-remark-queue.mjs";

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

test("same-job product-detail evidence materializes all six galleries without another provider call", t => {
  const root = mkdtempSync(path.join(tmpdir(), "sorftime-gallery-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const jobId = "32695ae9-5c7b-416b-86ac-1f34db864632";
  const asins = [
    "B086ZLGLV3",
    "B095NXXP8C",
    "B0C4DGFFCM",
    "B0CBV5DC7Y",
    "B0CDW797MM",
    "B0DJ7225F3",
  ];

  for (const asin of asins) {
    writeScopedSorftimeEvidence(createProductDetailEvidence({
      jobId,
      marketplace: "US",
      asin,
      fetchedAt: "2026-09-01T08:00:00.000Z",
      detail: {
        asin,
        main_image: JSON.stringify([
          `https://img.test/${asin}/main.jpg`,
          `https://img.test/${asin}/aux-1.jpg`,
          `https://img.test/${asin}/aux-2.jpg`,
        ]),
        a_plus: true,
      },
    }), { root });

    const evidence = readScopedSorftimeEvidence({
      jobId,
      marketplace: "US",
      asin,
      operation: "product_detail",
    }, { root });
    const record = buildListingRecordFromProductDetailEvidence(evidence);

    assert.equal(record.status, "ready");
    assert.equal(record.source, "Sorftime");
    assert.equal(record.provenance.jobId, jobId);
    assert.deepEqual(record.galleryImages, [
      `https://img.test/${asin}/main.jpg`,
      `https://img.test/${asin}/aux-1.jpg`,
      `https://img.test/${asin}/aux-2.jpg`,
    ]);
    assert.deepEqual(record.secondaryImages, record.galleryImages.slice(1));
  }

  assert.equal(readScopedSorftimeEvidence({
    jobId: "another-job",
    marketplace: "US",
    asin: asins[0],
    operation: "product_detail",
  }, { root }), null);
  assert.equal(readScopedSorftimeEvidence({
    jobId,
    marketplace: "CA",
    asin: asins[0],
    operation: "product_detail",
  }, { root }), null);
  assert.equal(readScopedSorftimeEvidence({
    jobId,
    marketplace: "US",
    asin: asins[0],
    operation: "product_detail",
    fetchedAt: "2026-09-01T09:00:00.000Z",
  }, { root }), null);
});

test("six persisted galleries submit each static image once and isolate one fixture AI failure", async () => {
  const asins = [
    "B086ZLGLV3",
    "B095NXXP8C",
    "B0C4DGFFCM",
    "B0CBV5DC7Y",
    "B0CDW797MM",
    "B0DJ7225F3",
  ];
  const items = asins.flatMap(asin => ["main", "aux-1", "aux-2"].map(slot => ({
    asin,
    url: `https://img.test/${asin}/${slot}.jpg`,
  })));
  const calls = new Map();
  const failedUrl = items[4].url;

  const results = await runImageRemarkQueue(items, async item => {
    calls.set(item.url, (calls.get(item.url) ?? 0) + 1);
    if (item.url === failedUrl) throw new Error("fixture image failure");
    return { status: "ready" };
  }, { concurrency: 4, timeoutMs: 100 });

  assert.equal(calls.size, items.length);
  assert.equal([...calls.values()].every(count => count === 1), true);
  assert.equal(results.filter(result => result.status === "ready").length, items.length - 1);
  assert.equal(results.filter(result => result.status === "connector-failed").length, 1);
  assert.equal(results.at(4).status, "connector-failed");
});

test("current-job evidence takes precedence over an older generated listing cache", () => {
  const evidence = createProductDetailEvidence({
    jobId: "current-job",
    marketplace: "US",
    asin: "B086ZLGLV3",
    fetchedAt: "2026-09-01T08:00:00.000Z",
    detail: {
      main_image: [
        "https://img.test/current/main.jpg",
        "https://img.test/current/aux.jpg",
      ],
    },
  });
  const olderCache = {
    asin: "B086ZLGLV3",
    status: "ready",
    galleryImages: ["https://img.test/old/main.jpg"],
  };

  const selected = selectScopedListingRecord({ evidence, existingRecord: olderCache });

  assert.deepEqual(selected.galleryImages, [
    "https://img.test/current/main.jpg",
    "https://img.test/current/aux.jpg",
  ]);
  assert.equal(selected.provenance.jobId, "current-job");
  assert.equal(selectScopedListingRecord({
    evidence: null,
    existingRecord: olderCache,
    requireScopedEvidence: true,
  }), null);
});

test("a scoped listing gap removes the stale generated record instead of republishing it", () => {
  const records = {
    B086ZLGLV3: { status: "ready", galleryImages: ["https://img.test/old/main.jpg"] },
  };
  discardUnscopedListingRecord(records, "B086ZLGLV3");
  assert.equal(Object.hasOwn(records, "B086ZLGLV3"), false);
});
