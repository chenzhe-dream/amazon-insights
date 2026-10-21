import assert from "node:assert/strict";
import test from "node:test";
import { CreateProjectRequestSchema, ProjectSchema, UpdateProjectRequestSchema } from "../../shared/agent-contracts";

for (const marketplace of ["US", "UK", "DE", "CA"]) {
  test(`${marketplace} project registration and response retain exact marketplace`, () => {
    const request = { name: "Scoped project", marketplace, asins: ["B0AAAA0001", "B0AAAA0002", "B0AAAA0003"] };
    assert.equal(CreateProjectRequestSchema.parse(request).marketplace, marketplace);
    assert.equal(UpdateProjectRequestSchema.parse({ marketplace }).marketplace, marketplace);
    assert.equal(ProjectSchema.parse({ ...request, id: "10000000-0000-4000-8000-000000000001", organizationId: "10000000-0000-4000-8000-000000000002", createdBy: "10000000-0000-4000-8000-000000000003", currentRunId: null, createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z" }).marketplace, marketplace);
  });
}
test("unsupported project marketplace remains invalid", () => {
  assert.equal(CreateProjectRequestSchema.safeParse({ name: "Invalid", marketplace: "FR", asins: ["B0AAAA0001", "B0AAAA0002", "B0AAAA0003"] }).success, false);
});


