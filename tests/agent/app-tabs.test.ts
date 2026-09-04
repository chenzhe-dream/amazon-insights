import assert from "node:assert/strict";
import test from "node:test";

import { isAppTab, tabFromParam } from "../../app/lib/app-tabs";

test("retired and unknown tab parameters fall back to the valid overview tab", () => {
  assert.equal(tabFromParam("overview-aplus"), "overview");
  assert.equal(tabFromParam("retired-bookmark"), "overview");
  assert.equal(tabFromParam(null), "overview");
  assert.equal(isAppTab("overview"), true);
});
