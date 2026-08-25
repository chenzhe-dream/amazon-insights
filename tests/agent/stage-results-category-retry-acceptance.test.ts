import assert from "node:assert/strict";
import test from "node:test";

import { createStageResultsCategoryRetryFixture } from "./helpers/stage-results-category-retry-fixture";

test("stage visibility and category retry pass one acceptance batch", async (t) => {
  const fixture = await createStageResultsCategoryRetryFixture();
  t.after(async () => fixture.close());

  const transient = await fixture.run({ category: ["CONNECT_TIMEOUT", "success"] });
  assert.deepEqual(transient.categoryAttemptKinds, ["initial", "transient-retry"]);
  assert.equal(transient.categoryReady, true);
  assert.equal(transient.followingStageRan, true);

  const permanent = await fixture.run({ category: ["CONNECT_TIMEOUT", "CONNECT_TIMEOUT"] });
  assert.equal(permanent.categoryDispatches, 2);
  assert.equal(permanent.thirdDispatches, 0);
  assert.deepEqual(permanent.categoryGap, { state: "failed", reasonCode: "CONNECT_TIMEOUT" });
  assert.equal(permanent.successfulModulesRemainVisible, true);

  assert.deepEqual(permanent.visibleBeforePublication, [
    "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
  ]);
  assert.equal(permanent.globalReloadsBeforeAppliedPublication, 0);
  assert.equal(permanent.stageOutputReadSideEffects, 0);
  assert.equal(permanent.artifactHashesMatch, true);
  assert.equal(permanent.fixtureBuilds, 0);

  const resumed = await fixture.resumeCategory(permanent.jobId);
  assert.deepEqual(resumed.newIds, { jobs: 0, runs: 0, runStages: 0 });
  assert.deepEqual(resumed.selectedStages, ["category"]);
  assert.equal(resumed.providerProbes, 0);
});
