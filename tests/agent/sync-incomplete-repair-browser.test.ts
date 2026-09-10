import assert from "node:assert/strict";
import test from "node:test";
import { createIncompleteSyncRepair } from "../../app/lib/sync-incomplete-repair-browser";

const scope = { asins: ["B07DYG1C9B", "B07VY9Q95Q"], marketplace: "US", projectId: "project", parentJobId: "parent" };
test("repair sends the entire workspace without the old run, and no-work does not adopt a job", async () => {
  let body: unknown;
  const repair = createIncompleteSyncRepair(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ noWork: true, message: "暂无待补抓数据" });
  });
  assert.deepEqual(await repair(scope, () => true), { noWork: true, message: "暂无待补抓数据" });
  assert.deepEqual(body, { ...scope, mode: "repair-incomplete" });
});
test("in-flight duplicate clicks are ignored and stale responses cannot replace workspace state", async () => {
  let finish!: (response: Response) => void;
  let current = true;
  let calls = 0;
  const repair = createIncompleteSyncRepair(async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); });
  const first = repair(scope, () => current);
  assert.equal(await repair(scope, () => true), null);
  current = false;
  finish(Response.json({ jobId: "new", scope: { projectId: "project", runId: "new-run" } }));
  assert.equal(await first, null);
  assert.equal(calls, 1);
});
test("repair adopts only a valid matching project with a canonical run", async () => {
  const valid = { jobId: "new", scope: { projectId: "project", runId: "new-run" } };
  assert.deepEqual(await createIncompleteSyncRepair(async () => Response.json(valid))(scope, () => true), valid);
  for (const payload of [{ ...valid, scope: { projectId: "other", runId: "new-run" } }, { ...valid, scope: { projectId: "project", runId: null } }, { noWork: true, jobId: "unexpected" }]) {
    await assert.rejects(createIncompleteSyncRepair(async () => Response.json(payload))(scope, () => true));
  }
});

test("a failed request releases the click guard so the user can retry", async () => {
  let calls = 0;
  const repair = createIncompleteSyncRepair(async () => {
    if (++calls === 1) return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
    return Response.json({ noWork: true, message: "暂无待补抓数据" });
  });
  await assert.rejects(repair(scope, () => true), /temporarily unavailable/);
  assert.deepEqual(await repair(scope, () => true), { noWork: true, message: "暂无待补抓数据" });
  assert.equal(calls, 2);
});
