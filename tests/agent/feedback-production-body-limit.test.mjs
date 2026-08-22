import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

const FEEDBACK_MULTIPART_LIMIT_BYTES = 3 * 5 * 1_048_576 + 128 * 1_024;
const ABOVE_DEFAULT_LIMIT_BYTES = 1_900_036;

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
}

async function waitForWeb(baseUrl, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Built Web exited before readiness: ${output.value}`);
    }
    try {
      await fetch(`${baseUrl}/api/health`);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Built Web did not start: ${output.value}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function multipartBody(byteLength, boundary) {
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="images"; filename="screen.png"\r\n' +
      "Content-Type: image/png\r\n\r\n",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  assert.ok(byteLength > prefix.byteLength + suffix.byteLength);
  return Buffer.concat([
    prefix,
    Buffer.alloc(byteLength - prefix.byteLength - suffix.byteLength, 0x61),
    suffix,
  ]);
}

async function postFeedback(baseUrl, byteLength) {
  const boundary = "production-feedback-limit";
  return fetch(`${baseUrl}/api/agent/v1/feedback`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: multipartBody(byteLength, boundary),
  });
}

test("built Web admits feedback multipart above 1 MiB and retains the feedback ceiling", { timeout: 60_000 }, async (t) => {
  const webPort = await reservePort();
  const unavailableAgentPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const output = { value: "" };
  const child = spawn(process.execPath, ["scripts/team-prod-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(webPort),
      AGENT_SERVICE_INTERNAL_URL: `http://127.0.0.1:${unavailableAgentPort}`,
      AGENT_SERVICE_PROXY_TOKEN: "feedback-production-test-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { output.value += chunk; });
  child.stderr.on("data", (chunk) => { output.value += chunk; });
  t.after(() => stopChild(child));
  await waitForWeb(baseUrl, child, output);

  const admitted = await postFeedback(baseUrl, ABOVE_DEFAULT_LIMIT_BYTES);
  assert.equal(admitted.status, 502);
  assert.equal((await admitted.json()).error.code, "AGENT_SERVICE_UNAVAILABLE");

  const rejected = await postFeedback(
    baseUrl,
    FEEDBACK_MULTIPART_LIMIT_BYTES + 1,
  );
  assert.equal(rejected.status, 413);
});
