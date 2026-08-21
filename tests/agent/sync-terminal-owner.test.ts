import assert from "node:assert/strict";
import test from "node:test";

import { createTerminalSyncOwner } from "../../app/lib/sync-terminal-owner";

class MemorySessionStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const asins = ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"];
const projectId = "10000000-0000-4000-8000-000000000003";
const organizationId = "10000000-0000-4000-8000-000000000001";
const otherOrganizationId = "20000000-0000-4000-8000-000000000001";

test("a page terminal owner survives remount, blocks auto start, and permits one explicit restart", () => {
  const storage = new MemorySessionStorage();
  const firstMount = createTerminalSyncOwner({
    storage,
    pathname: "/p/floor-lamps-de",
    organizationId,
    projectId,
    runId: "10000000-0000-4000-8000-000000000004",
    marketplace: "DE",
    asins: [...asins].reverse(),
  });
  assert.equal(firstMount.recordTerminal({ jobId: "job-terminal" }), true);

  const reloadedPage = createTerminalSyncOwner({
    storage,
    pathname: "/p/floor-lamps-de",
    organizationId,
    projectId,
    runId: "10000000-0000-4000-8000-000000000005",
    marketplace: "DE",
    asins,
  });
  let posts = 0;
  if (!reloadedPage.blocksAutomaticStart()) posts += 1;
  assert.equal(posts, 0, "same binding stays suppressed after a real remount");
  assert.equal(reloadedPage.readTerminal()?.jobId, "job-terminal");

  // Closing terminal UI is intentionally in-memory only; durable auto protection remains.
  assert.equal(reloadedPage.blocksAutomaticStart(), true);
  reloadedPage.clearForExplicitStart();
  if (!reloadedPage.blocksAutomaticStart()) posts += 1;
  assert.equal(posts, 1, "only explicit restart clears the tombstone");
});

test("terminal suppression is binding-scoped and stores bounded terminal metadata only", () => {
  const storage = new MemorySessionStorage();
  const owner = createTerminalSyncOwner({ storage, pathname: "/", organizationId, projectId: null, marketplace: "US", asins });
  assert.equal(owner.recordTerminal({ jobId: "job-terminal" }), true);

  const otherProject = createTerminalSyncOwner({ storage, pathname: "/", organizationId, projectId, marketplace: "US", asins });
  const otherMarket = createTerminalSyncOwner({ storage, pathname: "/", organizationId, projectId: null, marketplace: "DE", asins });
  assert.equal(otherProject.blocksAutomaticStart(), false);
  assert.equal(otherMarket.blocksAutomaticStart(), false);
  const persisted = [...(storage as unknown as { values: Map<string, string> }).values.values()].join("\n");
  assert.match(persisted, /job-terminal/);
  assert.doesNotMatch(persisted, /runId|provider/i);
});

test("terminal suppression follows organization binding rather than path or run audit metadata", () => {
  const storage = new MemorySessionStorage();
  const firstOwner = createTerminalSyncOwner({
    storage,
    pathname: "/p/floor-lamps-de",
    organizationId,
    projectId,
    marketplace: "DE",
    asins,
  });
  assert.equal(firstOwner.recordTerminal({ jobId: "job-terminal" }), true);

  const equivalentOtherPath = createTerminalSyncOwner({
    storage,
    pathname: "/",
    organizationId,
    projectId,
    marketplace: "DE",
    asins: [...asins].reverse(),
  });
  const foreignOrganization = createTerminalSyncOwner({
    storage,
    pathname: "/p/floor-lamps-de",
    organizationId: otherOrganizationId,
    projectId,
    marketplace: "DE",
    asins,
  });
  assert.equal(equivalentOtherPath.blocksAutomaticStart(), true, "a route change and creator run change cannot alter binding identity");
  assert.equal(foreignOrganization.blocksAutomaticStart(), false, "a different authenticated organization cannot inherit suppression");
});

test("missing or malformed authenticated organization and failing storage retain the safe fallback", () => {
  const unavailableStorage = {
    getItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("storage unavailable"); },
  };
  const invalidOrganization = createTerminalSyncOwner({
    storage: new MemorySessionStorage(),
    pathname: "/",
    organizationId: "not-authenticated",
    projectId,
    marketplace: "US",
    asins,
  });
  const failedStorage = createTerminalSyncOwner({
    storage: unavailableStorage,
    pathname: "/",
    organizationId,
    projectId,
    marketplace: "US",
    asins,
  });
  assert.equal(invalidOrganization.recordTerminal({ jobId: "job-terminal" }), false);
  assert.equal(failedStorage.recordTerminal({ jobId: "job-terminal" }), false);
  assert.equal(failedStorage.blocksAutomaticStart(), false);
});
