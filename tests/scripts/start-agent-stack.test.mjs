import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createStackLauncher as createStackLauncherImplementation,
  resolveStackSettings,
} from "../../scripts/start-agent-stack.mjs";

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

function createFakeArtifactStore(sequence = ["A", "B"]) {
  const currentArtifacts = sequence.map((id) => Object.freeze({ id, root: `artifact-${id}` }));
  const events = [];
  let currentIndex = 0;
  return {
    events,
    current() {
      const artifact = currentArtifacts[Math.min(currentIndex, currentArtifacts.length - 1)];
      currentIndex += 1;
      return artifact;
    },
    async snapshot(artifact) {
      events.push(`snapshot:${artifact.id}`);
      return Object.freeze({ id: `snapshot-${artifact.id}`, root: `snapshot-${artifact.id}` });
    },
    resolveArtifactPath(artifact) {
      events.push(`spawn:${artifact.id}`);
      return artifact.root;
    },
  };
}

function createStackLauncher(options) {
  return createStackLauncherImplementation({
    artifactStore: createFakeArtifactStore(["A"]),
    ...options,
  });
}

test("stack launcher defaults to Web 127.0.0.1:3001 and Agent 127.0.0.1:3100", () => {
  const settings = resolveStackSettings({}, "prod");

  assert.equal(settings.web.host, "127.0.0.1");
  assert.equal(settings.web.port, 3001);
  assert.equal(settings.agent.host, "127.0.0.1");
  assert.equal(settings.agent.port, 3100);
  assert.equal(settings.agent.internalUrl, "http://127.0.0.1:3100");
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
  const launcher = createStackLauncher({
    env: {
      WEB_PORT: "43123",
      AGENT_SERVICE_PORT: "43124",
      AGENT_SERVICE_READINESS_ORIGIN: "https://untrusted.example",
    },
    argv: ["prod"],
    platform: "linux",
    allocatePreflightPort: async () => 43125,
    spawn(command, args, options) {
      const child = new FakeChild(["agent", "old-web", "candidate-web", "new-web"][children.length]);
      if (children.length > 0) child.exitOnKill = true;
      children.push({ command, args, options, child });
      return child;
    },
    waitForHealth: async (url) => {
      healthProbes.push(url);
      if (url.includes(":43125")) assert.deepEqual(children[1].child.killedSignals, []);
    },
    reloadRequest: {
      consume: async ({ apply }) => {
        if (consumed) return { status: "duplicate" };
        consumed = true;
        await apply();
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
  assert.ok(healthProbes.some((url) => url.includes(":43125/api/health")));
  assert.ok(healthProbes.some((url) => url.includes(":43123/api/health")));
  assert.equal(children[1].options.env.AGENT_SERVICE_READINESS_ORIGIN, undefined);
  assert.equal(
    children[2].options.env.AGENT_SERVICE_READINESS_ORIGIN,
    "http://127.0.0.1:43123",
  );
  assert.equal(children[3].options.env.AGENT_SERVICE_READINESS_ORIGIN, undefined);
  assert.ok(children.every(({ args, options }) => options.windowsHide === true && !args.join(" ").includes("3000")));
});

test("a failed final Web health check restores the previous configured Web without stopping Agent", async () => {
  const children = [];
  let finalTargetChecks = 0;
  const artifacts = createFakeArtifactStore();
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
    waitForHealth: async (url) => {
      if (!url.includes(":43223/api/health")) return;
      finalTargetChecks += 1;
      if (finalTargetChecks === 2) throw new Error("target unavailable");
    },
    reloadRequest: { consume: async ({ apply }) => apply() },
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
  assert.deepEqual(artifacts.events, [
    "spawn:A",
    "snapshot:A",
    "spawn:B",
    "spawn:B",
    "spawn:snapshot-A",
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
    reloadRequest: { consume: async ({ apply }) => apply() },
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
    reloadRequest: { consume: async ({ apply }) => ({ status: "applied", replacement: await apply() }) },
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
    "snapshot:B",
  ]);
});
