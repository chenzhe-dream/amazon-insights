import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import dns from "node:dns";

import { callSifTool } from "../../../scripts/lib/sif-mcp-client.mjs";
import { ResourceGovernorAdmissionError } from "../../../scripts/lib/postgres-resource-governor.mjs";

const mode = process.env.FAKE_PROVIDER_MODE ?? "success";
const asin = process.env.FAKE_PROVIDER_ASIN ?? "B0TEST0001";
const outputPath = required("FAKE_PROVIDER_OUTPUT_PATH");
const attemptsPath = required("FAKE_PROVIDER_ATTEMPTS_PATH");

await mkdir(dirname(outputPath), { recursive: true });

if (mode === "network") {
  await writeFile(outputPath, JSON.stringify({
    proxyEnabled: process.env.NODE_USE_ENV_PROXY === "1",
    dispatcher: process.env.AGENT_PROVIDER_DISPATCHER ?? null,
    customCaPresent: Boolean(process.env.NODE_EXTRA_CA_CERTS),
    dnsResultOrder: dns.getDefaultResultOrder(),
  }), "utf8");
  process.exit(0);
}

const governor = {
  async run(input) {
    if (mode === "governor") throw new ResourceGovernorAdmissionError();
    await appendFile(attemptsPath, `${JSON.stringify({ resource: input.resource, attemptKind: input.attemptKind })}\n`, "utf8");
    return await input.operation();
  },
};

try {
  if (mode === "oversized-dns") {
    process.stdout.write(`unsafe-preamble-${"x".repeat(80_000)}\n`);
  }
  const result = await callSifTool("fixture_read", { asin }, {
    env: process.env,
    resourceGovernor: governor,
    organizationId: process.env.AGENT_EXECUTION_ORGANIZATION_ID,
    jobId: process.env.AGENT_SYNC_JOB_ID,
    fetchImpl: injectedFetch(mode),
  });
  const items = Array.isArray(result?.items) ? result.items : [];
  await writeFile(outputPath, JSON.stringify({
    asin,
    status: items.length > 0 ? "ready" : "upstream-empty",
    persisted: true,
    readiness: items.length > 0 ? "ready" : "upstream-empty",
  }), "utf8");
} catch (error) {
  const diagnostic = error && typeof error === "object" && "diagnostic" in error
    ? error.diagnostic
    : null;
  let secondFetchCalls = 0;
  if (mode === "degraded") {
    try {
      await callSifTool("fixture_read", { asin }, {
        env: process.env,
        resourceGovernor: governor,
        organizationId: process.env.AGENT_EXECUTION_ORGANIZATION_ID,
        jobId: process.env.AGENT_SYNC_JOB_ID,
        fetchImpl: async () => {
          secondFetchCalls += 1;
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { items: [{ asin }] } }));
        },
      });
    } catch {
      // The degraded connector must fail closed before this fetch runs.
    }
  }
  await writeFile(outputPath, JSON.stringify({
    asin,
    status: diagnostic?.failureKind === "timeout" ? "timeout" : "connector-failed",
    persisted: true,
    readiness: diagnostic?.failureKind === "timeout" ? "timeout" : "connector-failed",
    ...(mode === "degraded" ? { secondFetchCalls } : {}),
  }), "utf8");
}

function injectedFetch(failureMode) {
  if (!["dns", "tls", "timeout", "oversized-dns", "degraded"].includes(failureMode)) return fetch;
  const code = failureMode === "tls"
    ? "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    : failureMode === "timeout"
      ? "UND_ERR_CONNECT_TIMEOUT"
      : "ENOTFOUND";
  return async () => {
    const cause = Object.assign(new Error("unsafe provider address and credential sentinel"), { code });
    throw Object.assign(new TypeError("fetch failed"), { cause });
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
