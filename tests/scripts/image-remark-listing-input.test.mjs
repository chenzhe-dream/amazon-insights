import assert from "node:assert/strict";
import test from "node:test";

import { projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";
import { listingInputFromPersistedJob } from "../../scripts/lib/image-remark-listing-input.mjs";

const asin = "B07YGQVKDY";
const galleryImages = [
  "https://m.media-amazon.com/images/I/main.jpg",
  "https://m.media-amazon.com/images/I/secondary.jpg",
];

function persistedJob() {
  const output = projectStageOutput("listing", [asin], {
    organizationId: "org",
    projectId: "project",
    runId: "run",
    readExport: () => ({
      [asin]: { status: "ready", galleryImages, mainImage: galleryImages[0] },
    }),
  });
  return {
    jobId: "job",
    asins: [asin],
    scope: { organizationId: "org", projectId: "project", runId: "run" },
    outputs: [output],
  };
}

test("image remarks use the exact job's persisted main and secondary images", () => {
  const input = listingInputFromPersistedJob(persistedJob(), [asin]);
  assert.deepEqual(input[asin].galleryImages, galleryImages);
});

test("image remarks reject a corrupted persisted listing instead of processing zero images", () => {
  const job = persistedJob();
  job.outputs[0].data.contentByAsin[asin].galleryImages[1] = "https://example.test/changed.jpg";
  assert.throws(() => listingInputFromPersistedJob(job, [asin]), /hash/i);
});

test("image remarks reject another project's persisted listing", () => {
  const job = persistedJob();
  job.outputs[0].projectId = "another-project";
  assert.throws(() => listingInputFromPersistedJob(job, [asin]), /scope/i);
});
