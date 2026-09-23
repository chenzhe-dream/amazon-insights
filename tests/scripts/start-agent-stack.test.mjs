import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearWebArtifactManualRecoverySync,
  createWebArtifactStore,
  publishImmutableWebArtifact,
  writeCurrentWebArtifact,
} from "../../scripts/lib/web-artifact-store.mjs";
import {
  createStackLauncher as createStackLauncherImplementation,
  resolveStackSettings,
  waitForHealth,
} from "../../scripts/start-agent-stack.mjs";
import { commitWebPublicationControl, readWebPublicationControl, webPublicationControlPath } from "../../scripts/lib/web-publication-control.mjs";
import { createWebReloadTarget, writeWebReloadRequest } from "../../scripts/lib/web-reload-request.mjs";

const ARTIFACT_A = "a".repeat(64);
const ARTIFACT_B = "b".repeat(64);
const ARTIFACT_C = "c".repeat(64);
const STAGE_HASH_A = "d".repeat(64);
const STAGE_HASH_B = "e".repeat(64);
const STAGE_HASH_C = "f".repeat(64);

function reconciliation(artifactId, hash = artifactId === ARTIFACT_A ? STAGE_HASH_A : STAGE_HASH_B) {
  return Object.freeze({
    artifactId,
    jobId: "job-safe-123",
    jobVersion: artifactId === ARTIFACT_A ? 8 : 9,
    stageContentHashes: Object.freeze({ keywords: hash }),
  });
}

class FakeChild extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.killedSignals = [];
    this.exitCode = null;
    this.signalCode = null;
    this.pid = 10_000 + FakeChild.nextPid++;
  }

  kill(signal) {
    this.killedSignals.push(signal);
    if (this.exitOnKill) this.exit(0, signal);
    return true;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

FakeChild.nextPid = 1;

for (const failure of [null, "preflight", "final", "commit", "manifest"]) {
  test(`code supervisor uses real persistence and retains known-good on ${failure ?? "successful activation"}`, async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), "code-supervisor-"));
    const target = createWebReloadTarget({ worktree, webHost: "127.0.0.1", webPort: 43123 });
    const controlPath = webPublicationControlPath(worktree);
    const children = [], environments = [];
    const codeRelease = { sourceCommit: "1".repeat(40), sourceHash: "2".repeat(64), baseArtifactId: ARTIFACT_A };
    let launcher;
    try {
      const build = async () => { await mkdir(path.join(worktree, "dist"), { recursive: true }); await writeFile(path.join(worktree, "dist", "index.html"), "test build"); };
      await publishImmutableWebArtifact({ worktree, ...reconciliation(ARTIFACT_A), build });
      await commitWebPublicationControl({ controlPath, requestId: ARTIFACT_A, payload: { ...reconciliation(ARTIFACT_A), target } });
      const previous = await readWebPublicationControl({ controlPath });
      await publishImmutableWebArtifact({ worktree, artifactId: ARTIFACT_B, kind: "code", codeRelease, build });
      await writeWebReloadRequest({ artifactId: ARTIFACT_B, kind: "code", codeRelease: failure === "manifest" ? { ...codeRelease, sourceHash: ARTIFACT_C } : codeRelease, target, buildCompletedAt: new Date().toISOString() }, { spoolDir: path.join(worktree, "data", "web-reload-requests") });
      launcher = createStackLauncherImplementation({
        worktree,
        platform: "linux",
        env: { WEB_HOST: "127.0.0.1", WEB_PORT: "43123", AGENT_CODE_SOURCE_COMMIT: codeRelease.sourceCommit, AGENT_CODE_SOURCE_HASH: codeRelease.sourceHash },
        artifactStore: createWebArtifactStore({ worktree }),
        spawn: (_cmd, _args, options) => { const child = new FakeChild(`child-${children.length}`); child.exitOnKill = true; children.push(child); environments.push(options.env); return child; },
        waitForHealth: async (_url, options) => {
          if (options?.expectedArtifactId !== ARTIFACT_B) return;
          if (failure === "preflight" || failure === "final" && children.length === 4) throw new Error("health failed");
          if (failure === "commit" && children.length === 4) {
            // Simulate an intervening publisher at the final-health/commit boundary.
            await commitWebPublicationControl({ controlPath, requestId: ARTIFACT_C, payload: { ...reconciliation(ARTIFACT_C), target } });
          }
        },
        allocatePreflightPort: async () => 43124,
        terminateProcessTree: async ({ child }) => { child.exit(); return true; },
        publicationRecovery: async () => {},
        setIntervalImplementation: () => ({ unref() {} }),
        clearIntervalImplementation: () => {},
        onceProcessSignal: () => {},
      });
      await launcher.start();
      const result = await launcher.processReloadRequests();
      assert.equal(result.status, failure ? "failed" : "applied");
      const control = await readWebPublicationControl({ controlPath });
      if (!failure) {
        assert.equal(control.current.artifactId, ARTIFACT_B);
        assert.deepEqual(control.dataCurrent, previous.current);
        assert.equal(environments[3].WEB_CODE_SOURCE_COMMIT, codeRelease.sourceCommit);
        assert.equal(environments[3].WEB_CODE_SOURCE_HASH, codeRelease.sourceHash);
      } else if (failure !== "commit") assert.deepEqual(control, previous);
      if (failure === "manifest") assert.equal(children.length, 2);
      if (failure === "preflight") assert.equal(children.length, 3);
      if (failure === "commit") assert.equal(control.current.artifactId, ARTIFACT_C);
      if (failure === "final" || failure === "commit") assert.equal(children.length, 5);
      if (failure === "final" || failure === "commit") assert.equal(environments.at(-1).WEB_PUBLICATION_ARTIFACT_ID, ARTIFACT_A);
    } finally { await launcher?.cleanup("SIGTERM"); await rm(worktree, { recursive: true, force: true }); }
  });
}

test("new supervisor starts an old code artifact and publishes the next code artifact", async () => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "legacy-code-supervisor-"));
  const target = createWebReloadTarget({ worktree, webHost: "127.0.0.1", webPort: 43123 });
  const controlPath = webPublicationControlPath(worktree);
  const oldRelease = { sourceCommit: "1".repeat(40), sourceHash: "2".repeat(64), baseArtifactId: ARTIFACT_A };
  const nextRelease = { sourceCommit: "1".repeat(40), sourceHash: "3".repeat(64), baseArtifactId: ARTIFACT_B };
  let launcher;
  try {
    const build = async () => { await mkdir(path.join(worktree, "dist"), { recursive: true }); await writeFile(path.join(worktree, "dist", "index.html"), "test build"); };
    await publishImmutableWebArtifact({ worktree, ...reconciliation(ARTIFACT_A), build });
    await commitWebPublicationControl({ controlPath, requestId: ARTIFACT_A,
      payload: { ...reconciliation(ARTIFACT_A), target } });
    await publishImmutableWebArtifact({ worktree, artifactId: ARTIFACT_B, kind: "code", codeRelease: oldRelease, build });
    await commitWebPublicationControl({ controlPath, requestId: ARTIFACT_B,
      payload: { artifactId: ARTIFACT_B, kind: "code", codeRelease: oldRelease, target } });
    await publishImmutableWebArtifact({ worktree, artifactId: ARTIFACT_C, kind: "code", codeRelease: nextRelease, build });
    await writeWebReloadRequest({ artifactId: ARTIFACT_C, kind: "code", codeRelease: nextRelease,
      target, buildCompletedAt: new Date().toISOString() },
    { spoolDir: path.join(worktree, "data", "web-reload-requests") });
    const children = [];
    launcher = createStackLauncherImplementation({
      worktree, platform: "linux",
      env: { WEB_HOST: "127.0.0.1", WEB_PORT: "43123" },
      artifactStore: createWebArtifactStore({ worktree }),
      spawn: () => { const child = new FakeChild(`child-${children.length}`); child.exitOnKill = true; children.push(child); return child; },
      waitForHealth: async (url, options = {}) => {
        if (!options.expectedArtifactId) return;
        const release = options.expectedArtifactId === ARTIFACT_B ? oldRelease : nextRelease;
        return waitForHealth(url, { ...options,
          fetchImplementation: async () => Response.json({ status: "ok", artifactId: options.expectedArtifactId,
            codeRelease: release,
            ...(release === nextRelease ? { codeSource: { sourceCommit: release.sourceCommit, sourceHash: release.sourceHash } } : {}),
          }), timeoutMs: 0, intervalMs: 0,
        });
      },
      allocatePreflightPort: async () => 43124,
      terminateProcessTree: async ({ child }) => { child.exit(); return true; },
      publicationRecovery: async () => {},
      setIntervalImplementation: () => ({ unref() {} }), clearIntervalImplementation: () => {},
      onceProcessSignal: () => {},
    });
    await launcher.start();
    assert.equal((await launcher.processReloadRequests()).status, "applied");
    assert.equal((await readWebPublicationControl({ controlPath })).current.artifactId, ARTIFACT_C);
  } finally { await launcher?.cleanup("SIGTERM"); await rm(worktree, { recursive: true, force: true }); }
});

function createControlledClock() {
  const sleepers = [];
  return {
    clock: {
      sleep(milliseconds) {
        return new Promise((resolve) => {
          sleepers.push({ milliseconds, resolve });
        });
      },
    },
    sleepers,
  };
}

function killedSignalLists(children) {
  return children.map((child) => [...child.killedSignals]);
}

async function flushAsync() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function createFakeArtifactStore(sequence = [ARTIFACT_A, ARTIFACT_B]) {
  const labels = new Map([[ARTIFACT_A, "A"], [ARTIFACT_B, "B"], [ARTIFACT_C, "C"]]);
  const label = (artifact) => artifact.label ?? labels.get(artifact.id) ?? artifact.id;
  const currentArtifacts = sequence.map((id) => Object.freeze({
    id,
    label: labels.get(id),
    root: `artifact-${labels.get(id)}`,
    ...reconciliation(id),
  }));
  const events = [];
  const prunes = [];
  let mutableCurrent = currentArtifacts[0];
  return {
    events,
    prunes,
    current() {
      return mutableCurrent;
    },
    setCurrent(artifactId) {
      mutableCurrent = currentArtifacts.find((artifact) => artifact.id === artifactId) ?? mutableCurrent;
    },
    candidate(request) {
      return currentArtifacts.find((artifact) => artifact.id === request.artifactId)
        ?? currentArtifacts.at(-1);
    },
    async snapshot(artifact) {
      const artifactLabel = label(artifact);
      events.push(`snapshot:${artifactLabel}`);
      return Object.freeze({
        id: `snapshot-${artifactLabel}`,
        label: `snapshot-${artifactLabel}`,
        root: `snapshot-${artifactLabel}`,
        ...(artifact.publicationArtifactId ? { publicationArtifactId: artifact.publicationArtifactId } : {}),
        jobId: artifact.jobId,
        jobVersion: artifact.jobVersion,
        stageContentHashes: artifact.stageContentHashes,
      });
    },
    async prune({ protectedArtifacts = [] } = {}) {
      prunes.push(protectedArtifacts.map((artifact) => label(artifact)));
    },
    resolveArtifactPath(artifact) {
      events.push(`spawn:${label(artifact)}`);
      return artifact.root;
    },
  };
}

function createStackLauncher(options) {
  return createStackLauncherImplementation({
    artifactStore: createFakeArtifactStore([ARTIFACT_A]),
    ...options,
  });
}

test("health probing returns only the exact requested artifact identity", async () => {
  const result = await waitForHealth("http://127.0.0.1:3001/api/health", {
    expectedArtifactId: ARTIFACT_B,
    fetchImplementation: async () => Response.json({
      status: "ok",
      service: "web",
      agent: "ok",
      artifactId: ARTIFACT_B,
    }),
    timeoutMs: 0,
    intervalMs: 0,
  });

  assert.deepEqual(result, { artifactId: ARTIFACT_B });
  await assert.rejects(
    () => waitForHealth("http://127.0.0.1:3001/api/health", {
      expectedArtifactId: ARTIFACT_B,
      fetchImplementation: async () => Response.json({
        status: "ok",
        service: "web",
        agent: "ok",
        artifactId: ARTIFACT_C,
      }),
      timeoutMs: 0,
      intervalMs: 0,
    }),
    /artifact/i,
  );
});

test("stack launcher defaults to Web 127.0.0.1:3001 and Agent 127.0.0.1:3100", () => {
  const settings = resolveStackSettings({}, "prod");

  assert.equal(settings.web.host, "127.0.0.1");
  assert.equal(settings.web.port, 3001);
  assert.equal(settings.agent.host, "127.0.0.1");
  assert.equal(settings.agent.port, 3100);
  assert.equal(settings.agent.internalUrl, "http://127.0.0.1:3100");
});

test("supervisor starts Web from an unchanged known-good v1 manifest", async () => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "stack-v1-artifact-"));
  const artifactRoot = path.join(worktree, "dist");
  const manifest = path.join(artifactRoot, "web-artifact.json");
  const serialized = JSON.stringify({ version: 1, artifactId: ARTIFACT_A });
  const children = [];
  try {
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "index.html"), "known good v1");
    await writeFile(manifest, serialized);
    const launcher = createStackLauncher({
      env: { WEB_PORT: "43023", AGENT_SERVICE_PORT: "43024" },
      argv: ["prod"],
      platform: "linux",
      artifactStore: createWebArtifactStore({ worktree, artifactRoot }),
      spawn(command, args, options) {
        const child = new FakeChild(children.length === 0 ? "agent" : "web");
        children.push({ command, args, options, child });
        return child;
      },
      waitForHealth: async (_url, options = {}) => ({ artifactId: options.expectedArtifactId }),
      onceProcessSignal: () => undefined,
      exit: () => undefined,
    });

    await launcher.start();
    assert.equal(children.length, 2);
    assert.equal(children[1].options.env.WEB_PUBLICATION_ARTIFACT_ID, ARTIFACT_A);
    assert.equal(await readFile(manifest, "utf8"), serialized);
    assert.equal(await readFile(path.join(artifactRoot, "index.html"), "utf8"), "known good v1");
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("private-LAN prod launcher keeps development guard env and probes wildcard Web through loopback", () => {
  const settings = resolveStackSettings({
    NODE_ENV: "development",
    WEB_HOST: "0.0.0.0",
    WEB_PORT: "31900",
    AGENT_SERVICE_HOST: "127.0.0.1",
    AGENT_SERVICE_PORT: "31901",
  }, "prod");

  assert.equal(settings.mode, "prod");
  assert.equal(settings.web.host, "0.0.0.0");
  assert.equal(settings.web.port, 31900);
  assert.equal(settings.web.healthUrl, "http://127.0.0.1:31900/api/health");
  assert.equal(settings.agent.internalUrl, "http://127.0.0.1:31901");
});

test("private-LAN prod launcher preserves development NODE_ENV in both child environments", async () => {
  const children = [];
  const launcher = createStackLauncher({
    env: {
      NODE_ENV: "development",
      WEB_HOST: "0.0.0.0",
      WEB_PORT: "31900",
      AGENT_SERVICE_HOST: "127.0.0.1",
      AGENT_SERVICE_PORT: "31901",
    },
    argv: ["prod"],
    spawn(command, args, options) {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async () => undefined,
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();

  assert.equal(children.length, 2);
  assert.equal(children[0].options.env.NODE_ENV, "development");
  assert.equal(children[1].options.env.NODE_ENV, "development");
  assert.equal(children[0].options.env.AGENT_SERVICE_PORT, "31901");
  assert.equal(children[1].options.env.HOST, "0.0.0.0");
  assert.equal(children[1].options.env.PORT, "31900");
});

test("formal launcher rejects missing shared roots before spawning", async () => {
  const children = [];
  const launcher = createStackLauncher({
    env: { AGENT_FORMAL_WORKTREE_ROOT: path.resolve(import.meta.dirname, "../..") },
    argv: ["prod"],
    spawn(...args) {
      children.push(args);
      return new FakeChild("unexpected");
    },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await assert.rejects(() => launcher.start(), /AGENT_DATA_ROOT/);
  assert.equal(children.length, 0);
});

test("formal launcher passes the same resolved shared roots to both children", async () => {
  const children = [];
  const codeRoot = path.resolve(import.meta.dirname, "../..");
  const sharedRoot = path.resolve(os.tmpdir(), "canonical-runtime-launcher");
  const dataRoot = path.join(sharedRoot, "data");
  const runtimeRoot = path.join(sharedRoot, "runtime");
  const launcher = createStackLauncher({
    env: {
      AGENT_FORMAL_WORKTREE_ROOT: codeRoot,
      AGENT_DATA_ROOT: dataRoot,
      AGENT_RUNTIME_ROOT: runtimeRoot,
    },
    argv: ["prod"],
    spawn(command, args, options) {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async () => undefined,
    onceProcessSignal: () => undefined,
    exit: () => undefined,
    publicationRecovery: () => undefined,
  });

  await launcher.start();

  assert.equal(children.length, 2);
  for (const { options } of children) {
    assert.equal(options.env.AGENT_DATA_ROOT, dataRoot);
    assert.equal(options.env.AGENT_RUNTIME_ROOT, runtimeRoot);
  }
});

test("stack launcher starts exactly two Node child processes after health gates", async () => {
  const children = [];
  const probes = [];
  const publicationRecoveries = [];
  const launcher = createStackLauncher({
    env: {},
    argv: ["prod"],
    spawn(command, args, options) {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async (url) => {
      probes.push(url);
    },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
    publicationRecovery(options) { publicationRecoveries.push(options); },
  });

  await launcher.start();

  assert.equal(children.length, 2);
  assert.ok(children.every(({ command }) => command === process.execPath));
  assert.match(children[0].args.join(" "), /tsx.+server[/\\]index\.ts/);
  assert.match(children[1].args.join(" "), /scripts[/\\]team-prod-server\.mjs/);
  assert.ok(children.every(({ options }) => options.stdio === "inherit" && options.windowsHide === true));
  assert.equal(publicationRecoveries.length, 1);
  assert.equal(publicationRecoveries[0].worktree, path.resolve(import.meta.dirname, "../.."));
  assert.deepEqual(probes, ["http://127.0.0.1:3100/health", "http://127.0.0.1:3001/api/health"]);
});

test("stack launcher waits for graceful child exits before process exit", async () => {
  const children = [];
  let exitCode = null;
  let resolveExited;
  const exited = new Promise((resolve) => {
    resolveExited = resolve;
  });
  const signalHandlers = new Map();
  const { clock } = createControlledClock();
  const launcher = createStackLauncher({
    env: {},
    argv: ["prod"],
    spawn() {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push(child);
      return child;
    },
    waitForHealth: async () => undefined,
    onceProcessSignal(signal, handler) {
      signalHandlers.set(signal, handler);
    },
    exit(code) {
      exitCode = code;
      resolveExited(code);
    },
    platform: "linux",
    clock,
    cleanupTimeoutMs: 50,
  });

  await launcher.start();
  signalHandlers.get("SIGTERM")();
  await Promise.resolve();

  assert.deepEqual(killedSignalLists(children), [["SIGTERM"], ["SIGTERM"]]);
  assert.equal(exitCode, null);

  children[0].exit(0, null);
  await Promise.resolve();
  assert.equal(exitCode, null);

  children[1].exit(0, null);
  assert.equal(await exited, 0);
});

test("stack launcher escalates stuck children after the cleanup timeout", async () => {
  const children = [];
  let exitCode = null;
  let resolveExited;
  const exited = new Promise((resolve) => {
    resolveExited = resolve;
  });
  const signalHandlers = new Map();
  const { clock, sleepers } = createControlledClock();
  const launcher = createStackLauncher({
    env: {},
    argv: ["prod"],
    spawn() {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push(child);
      return child;
    },
    waitForHealth: async () => undefined,
    onceProcessSignal(signal, handler) {
      signalHandlers.set(signal, handler);
    },
    exit(code) {
      exitCode = code;
      resolveExited(code);
    },
    platform: "linux",
    clock,
    cleanupTimeoutMs: 25,
  });

  await launcher.start();
  signalHandlers.get("SIGINT")();
  await flushAsync();

  assert.deepEqual(killedSignalLists(children), [["SIGINT"], ["SIGINT"]]);
  assert.equal(exitCode, null);

  sleepers.shift().resolve();
  await flushAsync();
  assert.deepEqual(killedSignalLists(children), [
    ["SIGINT", "SIGKILL"],
    ["SIGINT", "SIGKILL"],
  ]);

  sleepers.shift().resolve();
  assert.equal(await exited, 0);
});

test("stack launcher uses Windows process-tree cleanup", async () => {
  const children = [];
  const signalHandlers = new Map();
  const treeKillCalls = [];
  let resolveExited;
  const exited = new Promise((resolve) => {
    resolveExited = resolve;
  });
  const launcher = createStackLauncher({
    env: {},
    argv: ["prod"],
    platform: "win32",
    spawn() {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push(child);
      return child;
    },
    waitForHealth: async () => undefined,
    onceProcessSignal(signal, handler) {
      signalHandlers.set(signal, handler);
    },
    async treeKill(child, signal) {
      treeKillCalls.push([child.pid, signal]);
      child.exit(0, signal);
    },
    exit(code) {
      resolveExited(code);
    },
  });

  await launcher.start();
  signalHandlers.get("SIGTERM")();

  assert.equal(await exited, 0);
  assert.deepEqual(treeKillCalls, [
    [children[0].pid, "SIGTERM"],
    [children[1].pid, "SIGTERM"],
  ]);
  assert.deepEqual(killedSignalLists(children), [[], []]);
});

test("stack launcher forwards shutdown signals idempotently without restart", async () => {
  const children = [];
  const signalHandlers = new Map();
  let exitCount = 0;
  let resolveExited;
  const exited = new Promise((resolve) => {
    resolveExited = resolve;
  });
  const launcher = createStackLauncher({
    env: {},
    argv: ["prod"],
    spawn() {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push(child);
      return child;
    },
    waitForHealth: async () => undefined,
    onceProcessSignal(signal, handler) {
      signalHandlers.set(signal, handler);
    },
    exit(code) {
      exitCount += 1;
      resolveExited(code);
    },
    platform: "linux",
  });

  await launcher.start();
  signalHandlers.get("SIGTERM")();
  signalHandlers.get("SIGTERM")();
  children[0].exit(0, "SIGTERM");
  children[1].exit(0, "SIGTERM");

  assert.equal(await exited, 0);
  assert.deepEqual(killedSignalLists(children), [["SIGTERM"], ["SIGTERM"]]);
  assert.equal(children.length, 2);
  assert.equal(exitCount, 1);
});

test("stack launcher terminates the peer and exits nonzero when a child exits unexpectedly", async () => {
  const children = [];
  let exitCode = null;
  let resolveExited;
  const exited = new Promise((resolve) => {
    resolveExited = resolve;
  });
  const launcher = createStackLauncher({
    env: {},
    argv: ["prod"],
    spawn() {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push(child);
      return child;
    },
    waitForHealth: async () => undefined,
    onceProcessSignal: () => undefined,
    exit(code) {
      exitCode = code;
      resolveExited(code);
    },
    platform: "linux",
  });

  await launcher.start();

  children[0].exit(1, null);
  await Promise.resolve();

  assert.deepEqual([...children[1].killedSignals], ["SIGTERM"]);
  assert.equal(exitCode, null);
  assert.equal(children.length, 2);

  children[1].exit(0, "SIGTERM");
  assert.equal(await exited, 1);
  assert.equal(exitCode, 1);
});

test("formal stack rejects local fake before spawning either child without leaking configuration", async () => {
  const children = [];
  const secret = "must-not-appear";
  const launcher = createStackLauncher({
    env: {
      AGENT_VOC_LOCAL_FAKE: "1",
      OPENAI_API_KEY: secret,
    },
    argv: ["prod"],
    spawn() {
      children.push(new FakeChild("unexpected"));
      return children.at(-1);
    },
    waitForHealth: async () => undefined,
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await assert.rejects(launcher.start(), (error) => {
    assert.equal(error instanceof Error, true);
    assert.equal(error.message, "Formal stack configuration is invalid");
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes("AGENT_VOC_LOCAL_FAKE"), false);
    return true;
  });
  assert.equal(children.length, 0);
});

test("development stack keeps the local fake fixture available", async () => {
  const children = [];
  const launcher = createStackLauncher({
    env: { AGENT_VOC_LOCAL_FAKE: "1" },
    argv: ["dev"],
    spawn(command, args, options) {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async () => undefined,
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  assert.equal(children.length, 2);
  assert.equal(children[0].options.env.AGENT_VOC_LOCAL_FAKE, "1");
});

test("a consumed reload request replaces Web once without replacing Agent or using port 3000", async () => {
  const children = [];
  const healthProbes = [];
  let consumed = false;
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  const launcher = createStackLauncher({
    env: {
      WEB_PORT: "43123",
      AGENT_SERVICE_PORT: "43124",
      AGENT_SERVICE_READINESS_ORIGIN: "https://untrusted.example",
    },
    argv: ["prod"],
    platform: "linux",
    allocatePreflightPort: async () => 43125,
    artifactStore: artifacts,
    spawn(command, args, options) {
      const child = new FakeChild(["agent", "old-web", "candidate-web", "new-web"][children.length]);
      if (children.length > 0) child.exitOnKill = true;
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async (url, options = {}) => {
      healthProbes.push({ url, expectedArtifactId: options.expectedArtifactId });
      if (url.includes(":43125")) assert.deepEqual(children[1].child.killedSignals, []);
      return { artifactId: options.expectedArtifactId };
    },
    reloadRequest: {
      consume: async ({ apply }) => {
        if (consumed) return { status: "duplicate" };
        consumed = true;
        await apply(reconciliation(ARTIFACT_B));
        return { status: "applied" };
      },
    },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  const agent = children[0].child;
  const oldWeb = children[1].child;
  assert.equal((await launcher.processReloadRequests()).status, "applied");
  assert.equal((await launcher.processReloadRequests()).status, "duplicate");

  assert.equal(children.length, 4);
  assert.equal(children[0].child, agent);
  assert.deepEqual(agent.killedSignals, []);
  assert.deepEqual(oldWeb.killedSignals, ["SIGTERM"]);
  assert.ok(healthProbes.some(({ url }) => url.includes(":43125/api/health")));
  assert.ok(healthProbes.some(({ url }) => url.includes(":43123/api/health")));
  assert.deepEqual(
    healthProbes.filter(({ expectedArtifactId }) => expectedArtifactId === ARTIFACT_B).map(({ url }) => url),
    ["http://127.0.0.1:43125/api/health", "http://127.0.0.1:43123/api/health"],
  );
  assert.equal(children[2].options.env.WEB_PUBLICATION_ARTIFACT_ID, ARTIFACT_B);
  assert.equal(children[3].options.env.WEB_PUBLICATION_ARTIFACT_ID, ARTIFACT_B);
  assert.equal(children[1].options.env.AGENT_SERVICE_READINESS_ORIGIN, undefined);
  assert.equal(
    children[2].options.env.AGENT_SERVICE_READINESS_ORIGIN,
    "http://127.0.0.1:43123",
  );
  assert.equal(children[3].options.env.AGENT_SERVICE_READINESS_ORIGIN, undefined);
  assert.ok(children.every(({ args, options }) => options.windowsHide === true && !args.join(" ").includes("3000")));
  assert.deepEqual(artifacts.prunes, [
    ["snapshot-A"],
    ["snapshot-A", "B"],
    ["B"],
    ["B"],
  ]);
});

test("a reload is rejected before candidate spawn when the manifest artifact differs from the request", async () => {
  const children = [];
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43133", AGENT_SERVICE_PORT: "43134" },
    argv: ["prod"],
    platform: "linux",
    artifactStore: artifacts,
    spawn(command, args, options) {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      if (children.length > 0) child.exitOnKill = true;
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async (_url, options = {}) => ({ artifactId: options.expectedArtifactId }),
    reloadRequest: { consume: async ({ apply }) => apply(reconciliation(ARTIFACT_C)) },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  await assert.rejects(() => launcher.processReloadRequests(), /artifact does not match reload request/i);
  assert.equal(children.length, 2);
  assert.deepEqual(artifacts.events, ["spawn:A", "snapshot:A"]);
});

test("supervisor starts request A from its snapshot after mutable current advances to B", async () => {
  const children = [];
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43143", AGENT_SERVICE_PORT: "43144" },
    argv: ["prod"],
    platform: "linux",
    allocatePreflightPort: async () => 43145,
    artifactStore: artifacts,
    spawn(command, args, options) {
      const child = new FakeChild(["agent", "old-web", "candidate-A", "final-A"][children.length]);
      if (children.length > 0) child.exitOnKill = true;
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async (_url, options = {}) => ({ artifactId: options.expectedArtifactId }),
    reloadRequest: { consume: async ({ apply }) => {
      artifacts.setCurrent(ARTIFACT_B);
      await apply(reconciliation(ARTIFACT_A));
      return { status: "applied" };
    } },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  assert.equal((await launcher.processReloadRequests()).status, "applied");
  assert.equal(children[2].options.env.WEB_ARTIFACT_ROOT, "artifact-A");
  assert.equal(children[3].options.env.WEB_ARTIFACT_ROOT, "artifact-A");
  assert.equal(children[2].options.env.WEB_PUBLICATION_ARTIFACT_ID, ARTIFACT_A);
  assert.deepEqual(artifacts.events, ["spawn:A", "snapshot:A", "spawn:A", "spawn:A"]);
});

test("a reload with stale stage hashes is rejected before candidate spawn and keeps known-good Web", async () => {
  const children = [];
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43433", AGENT_SERVICE_PORT: "43434" },
    argv: ["prod"],
    platform: "linux",
    artifactStore: artifacts,
    spawn(command, args, options) {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async (_url, options = {}) => ({ artifactId: options.expectedArtifactId }),
    reloadRequest: {
      consume: async ({ apply }) => apply(reconciliation(ARTIFACT_B, STAGE_HASH_C)),
    },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  await assert.rejects(() => launcher.processReloadRequests(), (error) => {
    assert.match(error.message, /content does not match reload request/i);
    assert.equal(error.code, "WEB_PUBLICATION_CONTENT_MISMATCH");
    return true;
  });
  assert.equal(children.length, 2);
  assert.deepEqual(children[1].child.killedSignals, []);
  assert.deepEqual(artifacts.events, ["spawn:A", "snapshot:A"]);
});

test("a failed final Web health check restores the previous configured Web without stopping Agent", async () => {
  const children = [];
  let finalTargetChecks = 0;
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  const identityChecks = [];
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43223", AGENT_SERVICE_PORT: "43224" },
    argv: ["prod"],
    platform: "linux",
    allocatePreflightPort: async () => 43225,
    spawn(command, args, options) {
      const child = new FakeChild(["agent", "old-web", "candidate-web", "failed-web", "restored-web"][children.length]);
      if (children.length > 0) child.exitOnKill = true;
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async (url, options = {}) => {
      identityChecks.push({ url, expectedArtifactId: options.expectedArtifactId });
      if (!url.includes(":43223/api/health")) return;
      finalTargetChecks += 1;
      if (finalTargetChecks === 2) throw new Error("target unavailable");
      return { artifactId: options.expectedArtifactId };
    },
    reloadRequest: { consume: async ({ apply }) => apply(reconciliation(ARTIFACT_B)) },
    artifactStore: artifacts,
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  const agent = children[0].child;
  const oldWeb = children[1].child;
  await assert.rejects(() => launcher.processReloadRequests(), /previous Web restored/);

  assert.equal(children.length, 5);
  assert.deepEqual(agent.killedSignals, []);
  assert.deepEqual(oldWeb.killedSignals, ["SIGTERM"]);
  assert.deepEqual(children[3].child.killedSignals, ["SIGTERM"]);
  assert.equal(children[4].options.env.PORT, "43223");
  assert.equal(children[2].options.env.WEB_PUBLICATION_ARTIFACT_ID, ARTIFACT_B);
  assert.equal(children[3].options.env.WEB_PUBLICATION_ARTIFACT_ID, ARTIFACT_B);
  assert.equal(children[4].options.env.WEB_PUBLICATION_ARTIFACT_ID, ARTIFACT_A);
  assert.deepEqual(
    identityChecks.filter(({ url }) => url.includes(":43223/api/health")).map(({ expectedArtifactId }) => expectedArtifactId),
    [ARTIFACT_A, ARTIFACT_B, ARTIFACT_A],
  );
  assert.deepEqual(artifacts.events, [
    "spawn:A",
    "snapshot:A",
    "spawn:B",
    "spawn:B",
    "spawn:snapshot-A",
  ]);
  assert.deepEqual(artifacts.prunes, [
    ["snapshot-A"],
    ["snapshot-A", "B"],
    ["snapshot-A"],
  ]);
});

test("an unconfirmed Windows process tree fences the supervisor and blocks later reload attempts", async () => {
  const children = [];
  let consumes = 0;
  let fenced = false;
  let treeKillCalls = 0;
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  let releaseDurableMark;
  const emergencyTokens = [];
  artifacts.persistManualRecoveryIntent = async (_error, { token }) => {
    emergencyTokens.push(token);
    return { token };
  };
  artifacts.markManualRecovery = async () => {
    fenced = true;
    await new Promise((resolve) => { releaseDurableMark = resolve; });
  };
  artifacts.assertOperational = () => { if (fenced) throw new Error("Web artifact store requires manual recovery"); };
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43443", AGENT_SERVICE_PORT: "43444" },
    argv: ["prod"],
    platform: "win32",
    cleanupTimeoutMs: 0,
    allocatePreflightPort: async () => 43445,
    artifactStore: artifacts,
    spawn() {
      const child = new FakeChild(["agent", "old-web", "candidate-web"][children.length]);
      children.push(child);
      return child;
    },
    treeKill: async () => {
      treeKillCalls += 1;
      if (treeKillCalls === 1) return;
      const error = new Error("process tree termination could not be confirmed");
      error.code = "EPROCESSTREE";
      error.treeIdentity = { pid: children.at(-1).pid };
      throw error;
    },
    waitForHealth: async () => undefined,
    reloadRequest: { consume: async ({ apply }) => { consumes += 1; return apply(reconciliation(ARTIFACT_B)); } },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  await assert.rejects(Promise.race([
    launcher.processReloadRequests(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("reload waited for durable fence")), 100)),
  ]), /termination could not be confirmed/i);
  await assert.rejects(() => launcher.processReloadRequests(), /termination could not be confirmed/i);
  assert.equal(consumes, 1);
  assert.equal(children.length, 3);
  assert.equal(emergencyTokens.length, 1);
  releaseDurableMark();
});

test("three canonical marker failures retain a durable intent and expose fatal manual-recovery state", async () => {
  const children = [];
  const durableTokens = [];
  let fullAttempts = 0;
  let treeKillCalls = 0;
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  artifacts.persistManualRecoveryIntent = async (_error, { token }) => {
    durableTokens.push(token);
    return { token };
  };
  artifacts.markManualRecovery = async () => {
    fullAttempts += 1;
    throw new Error("canonical disk unavailable");
  };
  artifacts.manualRecoveryStatus = async ({ tokens }) => ({ activeTokens: tokens, clearedTokens: [] });
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43463", AGENT_SERVICE_PORT: "43464" }, argv: ["prod"], platform: "win32",
    cleanupTimeoutMs: 0, allocatePreflightPort: async () => 43465, artifactStore: artifacts,
    spawn() { const child = new FakeChild(["agent", "web", "candidate"][children.length]); children.push(child); return child; },
    treeKill: async () => {
      treeKillCalls += 1;
      if (treeKillCalls === 1) return;
      throw Object.assign(new Error("unconfirmed tree"), { code: "EPROCESSTREE" });
    },
    waitForHealth: async () => undefined,
    reloadRequest: { consume: async ({ apply }) => apply(reconciliation(ARTIFACT_B)) },
    onceProcessSignal: () => undefined, exit: () => undefined,
  });
  await launcher.start();
  await assert.rejects(() => launcher.processReloadRequests(), /unconfirmed tree/);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(fullAttempts, 3);
  assert.equal(durableTokens.length, 1);
  assert.deepEqual(launcher.manualRecoveryState().map(({ durable, merged, fatal }) => ({ durable, merged, fatal })), [
    { durable: true, merged: false, fatal: true },
  ]);
});

test("simultaneous Agent and Web process-tree failures durably queue both identities before signal exit", async () => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "stack-dual-emergency-intent-"));
  const children = [];
  const signalHandlers = new Map();
  const persisted = [];
  const fullMarks = [];
  let exitCode = null;
  let resolveFirst;
  let resolveSecond;
  const firstDurable = new Promise((resolve) => { resolveFirst = resolve; });
  const secondDurable = new Promise((resolve) => { resolveSecond = resolve; });
  let resolveExited;
  const exited = new Promise((resolve) => { resolveExited = resolve; });
  const artifacts = createFakeArtifactStore([ARTIFACT_A]);
  const durableStore = createWebArtifactStore({ worktree });
  const lockOwner = spawn(process.execPath, [
    path.resolve("tests/fixtures/hold-interprocess-lock.mjs"),
    path.join(worktree, "data", "web-runtime-artifacts", ".build-artifact.lock"),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  artifacts.persistManualRecoveryIntent = async (error, { token }) => {
    persisted.push({ token, identity: error.treeIdentity });
    await (persisted.length === 1 ? firstDurable : secondDurable);
    return durableStore.persistManualRecoveryIntent(error, { token });
  };
  artifacts.markManualRecovery = async (_error, { token }) => { fullMarks.push(token); };
  artifacts.manualRecoveryStatus = async ({ tokens }) => ({ activeTokens: tokens, clearedTokens: [] });
  try {
    await once(lockOwner.stdout, "data");
    const launcher = createStackLauncher({
      worktree, env: {}, argv: ["prod"], platform: "win32", artifactStore: artifacts,
      spawn() { const child = new FakeChild(children.length ? "web" : "agent"); children.push(child); return child; },
      waitForHealth: async () => undefined,
      onceProcessSignal(signal, handler) { signalHandlers.set(signal, handler); },
      treeKill: async (child) => {
        const error = Object.assign(new Error(`tree-${child.name}`), { code: "EPROCESSTREE" });
        throw error;
      },
      exit(code) { exitCode = code; resolveExited(code); },
    });
    await launcher.start();
    signalHandlers.get("SIGTERM")();
    await flushAsync();
    assert.equal(persisted.length, 2);
    assert.equal(exitCode, null, "shutdown must wait for both emergency intents");
    resolveFirst();
    await flushAsync();
    assert.equal(exitCode, null);
    resolveSecond();
    assert.equal(await exited, 1);
    assert.equal(new Set(persisted.map(({ token }) => token)).size, 2);
    assert.deepEqual(persisted.map(({ identity }) => identity.pid).sort(), children.map(({ pid }) => pid).sort());
    assert.deepEqual(fullMarks, [], "signal shutdown must not wait on optional canonical merges");
    assert.equal((await readdir(path.join(
      worktree, "data", "web-runtime-artifacts", ".manual-recovery-intents",
    ))).filter((name) => name.endsWith(".json")).length, 2);
    assert.equal(lockOwner.exitCode, null, "emergency intents must not depend on the held artifact lock");
  } finally {
    if (lockOwner.exitCode === null && lockOwner.signalCode === null) {
      const lockExited = once(lockOwner, "exit"); lockOwner.kill("SIGKILL"); await lockExited;
    }
    await rm(worktree, { recursive: true, force: true });
  }
});

test("a cleared manual-recovery token releases the live fence and a new tree fences it again", async () => {
  const children = [];
  const active = new Set();
  const cleared = new Set();
  let consumes = 0;
  let killFailures = 0;
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  artifacts.persistManualRecoveryIntent = async (_error, { token }) => { active.add(token); return { token }; };
  artifacts.markManualRecovery = async () => undefined;
  artifacts.manualRecoveryStatus = async ({ tokens }) => ({
    activeTokens: tokens.filter((token) => active.has(token)),
    clearedTokens: tokens.filter((token) => cleared.has(token) && !active.has(token)),
  });
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43503", AGENT_SERVICE_PORT: "43504" }, argv: ["prod"], platform: "win32",
    cleanupTimeoutMs: 0, allocatePreflightPort: async () => 43505, artifactStore: artifacts,
    spawn() { const child = new FakeChild(["agent", "web", "candidate-a", "candidate-b"][children.length]); children.push(child); return child; },
    treeKill: async () => {
      killFailures += 1;
      if (killFailures === 1 || killFailures === 3) return;
      throw Object.assign(new Error(`tree-failure-${killFailures}`), { code: "EPROCESSTREE" });
    },
    waitForHealth: async () => undefined,
    reloadRequest: { consume: async ({ apply }) => { consumes += 1; return apply(reconciliation(ARTIFACT_B)); } },
    onceProcessSignal: () => undefined, exit: () => undefined,
  });
  await launcher.start();
  await assert.rejects(() => launcher.processReloadRequests(), /tree-failure-2/);
  const [firstToken] = active;
  active.delete(firstToken); cleared.add(firstToken);
  await assert.rejects(() => launcher.processReloadRequests(), /tree-failure-4/);
  assert.equal(consumes, 2, "clearing the first token must permit another reload attempt");
  assert.equal(active.size, 1);
  assert.notEqual([...active][0], firstToken);
});

test("a post-spawn child error does not retroactively mark the child as spawn-failed", async () => {
  const children = [];
  const launcher = createStackLauncher({
    env: {}, argv: ["prod"], platform: "linux", cleanupTimeoutMs: 0,
    spawn() { const child = new FakeChild(children.length ? "web" : "agent"); children.push(child); return child; },
    waitForHealth: async () => undefined,
    onceProcessSignal: () => undefined, exit: () => undefined,
  });
  await launcher.start();
  children[0].emit("error", new Error("late kill error"));
  await launcher.cleanup("SIGTERM");
  assert.deepEqual(children[0].killedSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(children[0].spawnError, undefined);
});

test("a spawn without a PID preserves its asynchronous spawn error", async () => {
  const spawnError = Object.assign(new Error("spawn ENOENT original"), { code: "ENOENT" });
  let healthCalls = 0;
  const launcher = createStackLauncher({
    env: {}, argv: ["prod"],
    spawn() {
      const child = new FakeChild("missing-agent");
      child.pid = undefined;
      setImmediate(() => { child.emit("error", spawnError); });
      return child;
    },
    waitForHealth: async () => { healthCalls += 1; },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });
  await assert.rejects(() => launcher.start(), (error) => error === spawnError);
  assert.equal(healthCalls, 0);
});

test("a Web child EPROCESSTREE writes a valid recoverable marker with its actual spawn identity", async () => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "web-child-tree-identity-"));
  const children = [];
  let treeKillCalls = 0;
  try {
    await mkdir(path.join(worktree, "dist"), { recursive: true });
    await writeFile(path.join(worktree, "dist", "index.html"), "A", "utf8");
    await writeCurrentWebArtifact({
      worktree, artifactId: ARTIFACT_A, jobId: "job-safe-123", jobVersion: 8,
      stageContentHashes: { keywords: STAGE_HASH_A },
    });
    const candidate = path.join(worktree, "data", "web-runtime-artifacts", `publication-${ARTIFACT_B}`);
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "index.html"), "B", "utf8");
    await writeFile(path.join(candidate, "web-artifact.json"), JSON.stringify({
      version: 2, artifactId: ARTIFACT_B, ...reconciliation(ARTIFACT_B),
    }), "utf8");
    const artifacts = createWebArtifactStore({ worktree });
    const launcher = createStackLauncher({
      worktree,
      env: { WEB_PORT: "43453", AGENT_SERVICE_PORT: "43454" },
      argv: ["prod"],
      platform: "win32",
      cleanupTimeoutMs: 0,
      allocatePreflightPort: async () => 43455,
      artifactStore: artifacts,
      spawn() {
        const child = new FakeChild(["agent", "old-web", "candidate-web"][children.length]);
        child.pid = 999_999_990 + children.length;
        children.push(child);
        return child;
      },
      treeKill: async () => {
        treeKillCalls += 1;
        if (treeKillCalls === 1) return;
        const error = new Error("Windows process tree termination could not be confirmed");
        error.code = "EPROCESSTREE";
        throw error;
      },
      waitForHealth: async () => undefined,
      reloadRequest: { consume: async ({ apply }) => apply(reconciliation(ARTIFACT_B)) },
      onceProcessSignal: () => undefined,
      exit: () => undefined,
    });
    await launcher.start();
    await assert.rejects(() => launcher.processReloadRequests(), /termination could not be confirmed/i);
    const intentNames = await readdir(path.join(
      worktree, "data", "web-runtime-artifacts", ".manual-recovery-intents",
    ));
    assert.equal(intentNames.filter((name) => name.endsWith(".json")).length, 1);
    const markerPath = path.join(worktree, "data", "web-runtime-artifacts", "manual-recovery.json");
    let marker;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { marker = JSON.parse(await readFile(markerPath, "utf8")); break; }
      catch (error) { if (error?.code !== "ENOENT") throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.ok(marker, "canonical marker should follow the already-durable emergency intent");
    const identity = marker.treeIdentities[0];
    assert.equal(identity.pid, children[2].pid);
    assert.match(identity.command, /team-prod-server\.mjs/);
    assert.equal(clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), true);
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("durable immutable current starts directly without snapshot or quota maintenance", async () => {
  const artifacts = createFakeArtifactStore([ARTIFACT_A]);
  artifacts.isImmutable = () => true;
  artifacts.snapshot = async () => { throw new Error("snapshot quota is full"); };
  const children = [];
  const launcher = createStackLauncher({
    env: {}, argv: ["prod"], artifactStore: artifacts,
    spawn() { const child = new FakeChild(children.length ? "web" : "agent"); children.push(child); return child; },
    waitForHealth: async () => undefined,
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });
  await launcher.start();
  assert.equal(children.length, 2);
  assert.deepEqual(artifacts.events, ["spawn:A"]);
});

test("health probing rejects an artifact whose running Web source differs from its manifest", async () => {
  const expectedCodeSource = { sourceCommit: "1".repeat(40), sourceHash: "2".repeat(64) };
  const matching = await waitForHealth("http://127.0.0.1:3001/api/health", {
    expectedArtifactId: ARTIFACT_B,
    expectedCodeSource,
    fetchImplementation: async () => Response.json({
      status: "ok", artifactId: ARTIFACT_B, codeSource: expectedCodeSource,
    }),
    timeoutMs: 0, intervalMs: 0,
  });
  assert.deepEqual(matching, { artifactId: ARTIFACT_B });
  await assert.rejects(
    () => waitForHealth("http://127.0.0.1:3001/api/health", {
      expectedArtifactId: ARTIFACT_B,
      expectedCodeSource,
      fetchImplementation: async () => Response.json({
        status: "ok", artifactId: ARTIFACT_B,
        codeSource: { ...expectedCodeSource, sourceHash: "3".repeat(64) },
      }),
      timeoutMs: 0, intervalMs: 0,
    }),
    /source/i,
  );
});

test("health probing accepts legacy code health only with its exact code release", async () => {
  const codeRelease = { sourceCommit: "1".repeat(40), sourceHash: "2".repeat(64), baseArtifactId: ARTIFACT_A };
  const legacyHealth = { status: "ok", artifactId: ARTIFACT_B, codeRelease };
  assert.deepEqual(await waitForHealth("http://127.0.0.1:3001/api/health", {
    expectedArtifactId: ARTIFACT_B, expectedCodeRelease: codeRelease,
    fetchImplementation: async () => Response.json(legacyHealth), timeoutMs: 0, intervalMs: 0,
  }), { artifactId: ARTIFACT_B });
  await assert.rejects(() => waitForHealth("http://127.0.0.1:3001/api/health", {
    expectedArtifactId: ARTIFACT_B, expectedCodeRelease: codeRelease,
    fetchImplementation: async () => Response.json({ ...legacyHealth,
      codeRelease: { ...codeRelease, baseArtifactId: ARTIFACT_C } }),
    timeoutMs: 0, intervalMs: 0,
  }), /source/i);
  await assert.rejects(() => waitForHealth("http://127.0.0.1:3001/api/health", {
    expectedArtifactId: ARTIFACT_B,
    expectedCodeSource: { sourceCommit: codeRelease.sourceCommit, sourceHash: codeRelease.sourceHash },
    fetchImplementation: async () => Response.json(legacyHealth), timeoutMs: 0, intervalMs: 0,
  }), /source/i);
});

test("business current restores its verified Web build source after supervisor restart", async () => {
  const codeSource = { sourceCommit: "1".repeat(40), sourceHash: "2".repeat(64) };
  const artifact = { id: ARTIFACT_A, root: "business-artifact", ...reconciliation(ARTIFACT_A), codeSource };
  const store = {
    current: () => artifact,
    isImmutable: () => true,
    resolveArtifactPath: item => item.root,
    prune: async () => undefined,
  };
  for (let restart = 0; restart < 2; restart += 1) {
    const environments = [];
    const children = [];
    const launcher = createStackLauncher({
      env: { WEB_PORT: "43123", AGENT_SERVICE_PORT: "43124" },
      argv: ["prod"], artifactStore: store,
      spawn(_command, _args, options) {
        const child = new FakeChild(children.length ? "web" : "agent");
        child.exitOnKill = true;
        children.push(child);
        environments.push(options.env);
        return child;
      },
      waitForHealth: async () => undefined,
      onceProcessSignal: () => undefined,
      setIntervalImplementation: () => ({ unref() {} }),
      clearIntervalImplementation: () => undefined,
      platform: "linux",
    });
    try {
      await launcher.start();
      assert.equal(environments[1].WEB_PUBLICATION_ARTIFACT_ID, ARTIFACT_A);
      assert.equal(environments[1].WEB_BUILD_SOURCE_COMMIT, codeSource.sourceCommit);
      assert.equal(environments[1].WEB_BUILD_SOURCE_HASH, codeSource.sourceHash);
      assert.equal(environments[1].WEB_CODE_BASE_ARTIFACT_ID, undefined);
    } finally {
      await launcher.cleanup("SIGTERM");
    }
  }
});

test("a durable applied-generation commit failure rolls back the healthy candidate before known-good advances", async () => {
  const children = [];
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  let commitCalls = 0;
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43233", AGENT_SERVICE_PORT: "43234" },
    argv: ["prod"],
    platform: "linux",
    allocatePreflightPort: async () => 43235,
    artifactStore: artifacts,
    spawn() {
      const child = new FakeChild(["agent", "old-web", "preflight-B", "final-B", "rollback-A"][children.length]);
      if (children.length > 0) child.exitOnKill = true;
      children.push(child);
      return child;
    },
    waitForHealth: async () => undefined,
    reloadRequest: {
      consume: async ({ apply }) => apply(reconciliation(ARTIFACT_B), {
        commitHighWater: async () => {
          commitCalls += 1;
          throw new Error("high-water fsync failed");
        },
      }),
    },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  await assert.rejects(() => launcher.processReloadRequests(), /previous Web restored/i);
  assert.equal(commitCalls, 1);
  assert.equal(children.length, 5);
  assert.deepEqual(children[3].killedSignals, ["SIGTERM"]);
  assert.equal(children[4].name, "rollback-A");
  assert.deepEqual(artifacts.events, [
    "spawn:A",
    "snapshot:A",
    "spawn:B",
    "spawn:B",
    "spawn:snapshot-A",
  ]);
});

test("a candidate exit during durable commit restarts the committed artifact and never rolls back old Web", async () => {
  const children = [];
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43243", AGENT_SERVICE_PORT: "43244" },
    argv: ["prod"],
    platform: "linux",
    allocatePreflightPort: async () => 43245,
    artifactStore: artifacts,
    spawn() {
      const child = new FakeChild(["agent", "old-web", "preflight-B", "final-B", "recovered-B"][children.length]);
      if (children.length > 0) child.exitOnKill = true;
      children.push(child);
      return child;
    },
    waitForHealth: async () => undefined,
    reloadRequest: {
      consume: async ({ apply }) => ({
        status: "applied",
        replacement: await apply(reconciliation(ARTIFACT_B), {
          commitHighWater: async () => { children[3].exit(1); },
        }),
      }),
    },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  assert.equal((await launcher.processReloadRequests()).status, "applied");
  assert.equal(children.length, 5);
  assert.equal(children[4].name, "recovered-B");
  assert.equal(children[4].options?.env?.WEB_PUBLICATION_ARTIFACT_ID ?? ARTIFACT_B, ARTIFACT_B);
  assert.deepEqual(artifacts.events, [
    "spawn:A",
    "snapshot:A",
    "spawn:B",
    "spawn:B",
    "spawn:B",
  ]);
});

test("a final candidate exit during validation rolls back Web locally without global Agent cleanup", async () => {
  const children = [];
  let targetHealthChecks = 0;
  const artifacts = createFakeArtifactStore();
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43323", AGENT_SERVICE_PORT: "43324" },
    argv: ["prod"],
    platform: "linux",
    allocatePreflightPort: async () => 43325,
    artifactStore: artifacts,
    spawn(command, args, options) {
      const child = new FakeChild(["agent", "old-web", "preflight-B", "final-B", "rollback-A"][children.length]);
      child.exitOnKill = true;
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async (url) => {
      if (!url.includes(":43323/api/health")) return;
      targetHealthChecks += 1;
      if (targetHealthChecks === 2) {
        children[3].child.exit(1, null);
        throw new Error("final candidate exited");
      }
    },
    reloadRequest: { consume: async ({ apply }) => apply(reconciliation(ARTIFACT_B)) },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  const agent = children[0].child;
  await assert.rejects(() => launcher.processReloadRequests(), /previous Web restored/);
  await flushAsync();

  assert.deepEqual(agent.killedSignals, []);
  assert.equal(children.length, 5);
  assert.deepEqual(artifacts.events, [
    "spawn:A",
    "snapshot:A",
    "spawn:B",
    "spawn:B",
    "spawn:snapshot-A",
  ]);
});

test("a healthy replacement advances the known-good snapshot only after target health succeeds", async () => {
  const children = [];
  const artifacts = createFakeArtifactStore();
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43423", AGENT_SERVICE_PORT: "43424" },
    argv: ["prod"],
    platform: "linux",
    allocatePreflightPort: async () => 43425,
    artifactStore: artifacts,
    spawn(command, args, options) {
      const child = new FakeChild(["agent", "old-web", "preflight-B", "final-B"][children.length]);
      if (children.length > 0) child.exitOnKill = true;
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async () => undefined,
    reloadRequest: {
      consume: async ({ apply }) => ({
        status: "applied",
        replacement: await apply(reconciliation(ARTIFACT_B)),
      }),
    },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  assert.equal((await launcher.processReloadRequests()).status, "applied");
  assert.deepEqual(artifacts.events, [
    "spawn:A",
    "snapshot:A",
    "spawn:B",
    "spawn:B",
  ]);
});

test("retention protects a second pending artifact while the first request is processing", async () => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "stack-retention-processing-"));
  try {
    const artifactRoot = path.join(worktree, "dist");
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "index.html"), "initial C");
    await writeCurrentWebArtifact({ worktree, ...reconciliation(ARTIFACT_C) });
    const artifacts = createWebArtifactStore({ worktree, maxSnapshots: 2 });
    const children = [];
    let activeRequests = [];
    const launcher = createStackLauncher({
      env: { WEB_PORT: "43523", AGENT_SERVICE_PORT: "43524" },
      argv: ["prod"],
      platform: "linux",
      allocatePreflightPort: async () => 43525,
      artifactStore: artifacts,
      spawn() {
        const child = new FakeChild(["agent", "old-web", "preflight-A", "final-A"][children.length]);
        if (children.length > 0) child.exitOnKill = true;
        children.push(child);
        return child;
      },
      waitForHealth: async () => undefined,
      reloadRequest: {
        readActive: async () => activeRequests,
        consume: async ({ apply }) => {
          await apply(reconciliation(ARTIFACT_A));
          activeRequests = [reconciliation(ARTIFACT_B)];
          return { status: "applied" };
        },
      },
      onceProcessSignal: () => undefined,
      exit: () => undefined,
    });

    await launcher.start();
    for (const artifactId of [ARTIFACT_A, ARTIFACT_B]) {
      const identity = reconciliation(artifactId);
      await publishImmutableWebArtifact({
        worktree,
        ...identity,
        build: async () => { await writeFile(path.join(artifactRoot, "index.html"), artifactId); },
      });
    }
    activeRequests = [reconciliation(ARTIFACT_A), reconciliation(ARTIFACT_B)];
    await launcher.processReloadRequests();
    const names = await readdir(path.join(worktree, "data", "web-runtime-artifacts"));
    assert.ok(names.includes(`publication-${ARTIFACT_A}`));
    assert.ok(names.includes(`publication-${ARTIFACT_B}`));
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("an empty reload poll still protects every pending artifact from cleanup", async () => {
  const children = [];
  const artifacts = createFakeArtifactStore([ARTIFACT_A, ARTIFACT_B]);
  let activeRequests = [];
  const launcher = createStackLauncher({
    env: { WEB_PORT: "43623", AGENT_SERVICE_PORT: "43624" },
    argv: ["prod"],
    platform: "linux",
    artifactStore: artifacts,
    spawn() {
      const child = new FakeChild(children.length === 0 ? "agent" : "web");
      children.push(child);
      return child;
    },
    waitForHealth: async () => undefined,
    reloadRequest: {
      readActive: async () => activeRequests,
      consume: async () => ({ status: "none" }),
    },
    onceProcessSignal: () => undefined,
    exit: () => undefined,
  });

  await launcher.start();
  activeRequests = [reconciliation(ARTIFACT_B)];
  assert.equal((await launcher.processReloadRequests()).status, "none");
  assert.deepEqual(artifacts.prunes.at(-1), ["snapshot-A", "B"]);
});
