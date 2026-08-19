import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createStackLauncher,
  resolveStackSettings,
} from "../../scripts/start-agent-stack.mjs";

class FakeChild extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.killedSignals = [];
    this.exitCode = null;
  }

  kill(signal) {
    this.killedSignals.push(signal);
    return true;
  }
}

test("stack launcher defaults to Web 127.0.0.1:3001 and Agent 127.0.0.1:3100", () => {
  const settings = resolveStackSettings({}, "prod");

  assert.equal(settings.web.host, "127.0.0.1");
  assert.equal(settings.web.port, 3001);
  assert.equal(settings.agent.host, "127.0.0.1");
  assert.equal(settings.agent.port, 3100);
  assert.equal(settings.agent.internalUrl, "http://127.0.0.1:3100");
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

test("stack launcher forwards one shutdown signal only once", async () => {
  const children = [];
  let exitCode = null;
  const signalHandlers = new Map();
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
    },
    cleanupTimeoutMs: 1,
  });

  await launcher.start();
  signalHandlers.get("SIGTERM")();
  signalHandlers.get("SIGTERM")();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(children.map((child) => child.killedSignals), [["SIGTERM"], ["SIGTERM"]]);
  assert.equal(exitCode, 0);
});

test("stack launcher terminates the peer and exits nonzero when a child exits unexpectedly", async () => {
  const children = [];
  let exitCode = null;
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
    },
    cleanupTimeoutMs: 1,
  });

  await launcher.start();

  children[0].emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(children[1].killedSignals, ["SIGTERM"]);
  assert.equal(exitCode, 1);
});
