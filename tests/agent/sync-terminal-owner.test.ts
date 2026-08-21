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

test("a page terminal owner survives remount, blocks auto start, and permits one explicit restart", () => {
  const storage = new MemorySessionStorage();
  const firstMount = createTerminalSyncOwner({
    storage,
    pathname: "/p/floor-lamps-de",
    projectId,
    marketplace: "DE",
    asins: [...asins].reverse(),
  });
  firstMount.recordTerminal({ jobId: "job-terminal" });

  const reloadedPage = createTerminalSyncOwner({
    storage,
    pathname: "/p/floor-lamps-de",
    projectId,
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
  const owner = createTerminalSyncOwner({ storage, pathname: "/", projectId: null, marketplace: "US", asins });
  owner.recordTerminal({ jobId: "job-terminal" });

  const otherProject = createTerminalSyncOwner({ storage, pathname: "/", projectId, marketplace: "US", asins });
  const otherMarket = createTerminalSyncOwner({ storage, pathname: "/", projectId: null, marketplace: "DE", asins });
  assert.equal(otherProject.blocksAutomaticStart(), false);
  assert.equal(otherMarket.blocksAutomaticStart(), false);
  const persisted = [...(storage as unknown as { values: Map<string, string> }).values.values()].join("\n");
  assert.match(persisted, /job-terminal/);
  assert.doesNotMatch(persisted, /runId|organizationId|provider/i);
});
