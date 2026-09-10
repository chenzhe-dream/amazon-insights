import assert from "node:assert/strict";
import test from "node:test";
import { classifyRoute } from "../../server/auth/authorization";

test("shared history deletion is admin-only while favorite removal remains available to members", () => {
  assert.deepEqual(classifyRoute("DELETE", "/v1/local-data/projects/10000000-0000-4000-8000-000000000001"), { kind: "session", roles: ["admin"] });
  assert.deepEqual(classifyRoute("DELETE", "/v1/local-data/projects/10000000-0000-4000-8000-000000000001/favorite"), { kind: "session", roles: ["admin", "member"] });
});
