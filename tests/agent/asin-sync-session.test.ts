import assert from "node:assert/strict";
import test from "node:test";

import { createSyncStartGate } from "../../app/lib/asin-sync-session";

test("a sync funnel session only starts one POST even after an equivalent rerender", () => {
  const startOnce = createSyncStartGate();

  assert.equal(startOnce(), true);
  assert.equal(startOnce(), false);
});
