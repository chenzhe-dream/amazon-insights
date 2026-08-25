import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWebArtifactStore,
  publishImmutableWebArtifact,
  writeCurrentWebArtifact,
} from "../../scripts/lib/web-artifact-store.mjs";
import {
  createStackLauncher as createStackLauncherImplementation,
  resolveStackSettings,
  waitForHealth,
} from "../../scripts/start-agent-stack.mjs";

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

test("stack launcher starts exactly two Node child processes after health gates", async () => {
  const children = [];
  const probes = [];
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
  });

  await launcher.start();

  assert.equal(children.length, 2);
  assert.ok(children.every(({ command }) => command === process.execPath));
  assert.match(children[0].args.join(" "), /tsx.+server[/\\]index\.ts/);
  assert.match(children[1].args.join(" "), /scripts[/\\]team-prod-server\.mjs/);
  assert.ok(children.every(({ options }) => options.stdio === "inherit" && options.windowsHide === true));
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
