import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

test("image worker counts persisted secondary images when the code checkout has no gallery", async t => {
  const root = path.resolve(import.meta.dirname, "../..");
  const fixture = fs.mkdtempSync(path.join(root, ".tmp-image-listing-stage-test-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "app"), { recursive: true });
  fs.copyFileSync(path.join(root, "scripts/build-listing-image-remarks.mjs"), path.join(fixture, "scripts/build-listing-image-remarks.mjs"));
  fs.cpSync(path.join(root, "scripts/lib"), path.join(fixture, "scripts/lib"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "app/sorftime-listing-content-data.ts"), "export const sorftimeListingContentData = {};\n");
  fs.writeFileSync(path.join(fixture, "app/listing-image-remarks.ts"),
    "export const listingImageRemarksMeta = {};\nexport const listingImageRemarks = {};\n");
  const input = path.join(fixture, "listing.json");
  fs.writeFileSync(input, JSON.stringify({ jobId: "job", job: persistedJob() }));
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(fixture, "scripts/build-listing-image-remarks.mjs")], {
      cwd: fixture,
      env: { ...process.env, OPENAI_API_KEY: "", REMARK_ASINS: asin,
        AGENT_SYNC_JOB_ID: "job", AGENT_SYNC_LISTING_STAGE_FILE: input,
        AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, output }));
  });
  assert.equal(outcome.code, 2, outcome.output);
  assert.match(outcome.output, /"total":2/);
  assert.match(outcome.output, /"connector-failed":2/);
});

test("valid missing galleries are partitioned without discarding ready siblings", async () => {
  const { partitionImageListingInput } = await import("../../scripts/lib/image-remark-listing-input.mjs");
  const job = persistedJob();
  job.asins.push("B000000002");
  const { persistedStageOutputContentHash } = await import("../../scripts/lib/sync-stage-output.mjs");
  job.outputs[0].asins = [...job.asins];
  job.outputs[0].contentHash = persistedStageOutputContentHash(job.outputs[0]);
  const result = partitionImageListingInput(job, job.asins);
  assert.deepEqual(result.readyAsins, [asin]);
  assert.deepEqual(result.missingAsins, ["B000000002"]);
  assert.deepEqual(result.listingByAsin[asin].galleryImages, galleryImages);
  job.outputs[0].data.contentByAsin[asin].galleryImages.push("https://example.test/corrupt.jpg");
  assert.throws(() => partitionImageListingInput(job, job.asins), /hash/i);
});
