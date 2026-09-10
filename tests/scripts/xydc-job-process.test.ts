import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import path from "node:path";
import { test } from "node:test";
import { startPostgresTestContainer } from "../agent/helpers/postgres-test-container";
import { httpFixture, fixtureFamily, fixtureOrders } from "../helpers/xydc-http-fixture";
import { writeXydcVariantFamily } from "../../scripts/lib/xydc-variant-cache";
import { readFile } from "node:fs/promises";
import { xydcOrderProgressPath } from "../../scripts/lib/xydc-order-job-progress";

const root = path.resolve(import.meta.dirname, "../..");
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error("fixture condition timeout"); await delay(25); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const cancellation of ["parent-death", "sigterm", "db-cancelled", "heartbeat-then-cancel", "success"] as const) {
  test(`actual XYDC HTTP stops during 429 wait after ${cancellation}`, async t => {
    const postgres = await startPostgresTestContainer();
    let calledTool: string | undefined;
    const fixture = await httpFixture((body, _req, res) => {
      if (body.method !== "tools/call") return false;
      calledTool = (body as { params?: { name?: string } }).params?.name;
      if (cancellation === "success") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: fixtureOrders(body.params!.arguments!.asin!, "US", 0) } }));
        return true;
      }
      res.writeHead(429, { "Retry-After": "120" }).end();
      return true;
    });
    let child: ReturnType<typeof spawn> | undefined;
    let descendant: number | undefined;
    let tracked: number[] = [];
    try {
      await postgres.pool.query(`CREATE TABLE analysis_runs(id text PRIMARY KEY, project_id text, status text);
        CREATE TABLE sync_jobs(job_id text PRIMARY KEY, organization_id text, project_id text, run_id text, marketplace text,
        asins jsonb, stages jsonb DEFAULT '[]', status text, leased_by text, lease_generation integer, lease_expires_at timestamptz, created_at timestamptz DEFAULT now());
        INSERT INTO analysis_runs VALUES ('run','project','succeeded');
        INSERT INTO sync_jobs(job_id,organization_id,project_id,run_id,marketplace,asins,status,leased_by,lease_generation,lease_expires_at)
          VALUES ('job','org','project','run','US','["B0CHILD001","B0CHILD002"]','running','worker',1,now()+interval '1 hour')`);
      const family = fixtureFamily();
      family.fetchedAt = new Date().toISOString();
      family.status = "ready"; family.reasonCode = null;
      family.children = family.children.map(item => ({ ...item, infoStatus: "ready" }));
      const dataRoot = path.join(fixture.root, "data");
      await writeXydcVariantFamily(dataRoot, family.country, family);
      await writeXydcVariantFamily(dataRoot, family.country, { ...family, inputAsin: "B0CHILD002" });
      const options = postgres.pool.options;
      const env = { ...process.env, ...fixture.env, XYDC_MCP_TOKEN: "local-fixture-only", XYDC_ASINS: "B0CHILD001,B0CHILD002",
        AGENT_DATABASE_URL: `postgresql://postgres@127.0.0.1:${options.port}/${options.database}`,
        AGENT_DATA_ROOT: dataRoot, AGENT_RUNTIME_ROOT: path.join(fixture.root, "runtime"),
        AGENT_EXECUTION_ORGANIZATION_ID: "org", AGENT_XYDC_PROJECT_ID: "project", AGENT_XYDC_RUN_ID: "run",
        AGENT_SYNC_JOB_ID: "job", AGENT_RESOURCE_GOVERNOR_OWNER_ID: "worker", AGENT_XYDC_LEASE_GENERATION: "1",
        AGENT_XYDC_PARENT_IPC: "1" };
      const script = cancellation === "parent-death" ? "tests/helpers/xydc-runner-process.mjs" : "scripts/build-xydc-variant-data.ts";
      child = spawn(process.execPath, cancellation === "parent-death" ? [script] : ["--import", "tsx", script], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let diagnostics = "";
      child.stderr!.on("data", chunk => { diagnostics += chunk; });
      const closed = once(child, "close");
      await until(() => fixture.requests.some(request => request.rpc === "tools/call") || child!.exitCode !== null);
      assert.equal(child.exitCode, null, diagnostics);
      assert.equal(calledTool, "get_asin_order_trends");
      const sidecar = xydcOrderProgressPath(env.AGENT_RUNTIME_ROOT, { jobId: "job", leaseGeneration: 1 });
      if (cancellation === "success") {
        await Promise.race([closed, delay(10_000).then(() => { throw new Error("successful XYDC process did not close"); })]);
        const completed = JSON.parse(await readFile(sidecar, "utf8"));
        assert.equal(completed.state, "completed");
        assert.equal(completed.children.length, 2);
        assert.equal(completed.children.every((item: { state: string }) => item.state === "ready"), true);
        assert.equal(fixture.requests.filter(request => request.rpc === "tools/call").length, 2);
        assert.equal(child.exitCode, 0);
        return;
      }
      await until(async () => { try { return JSON.parse(await readFile(sidecar, "utf8")).state === "rate-wait"; } catch { return false; } });
      if (cancellation === "heartbeat-then-cancel") {
        const before = JSON.parse(await readFile(sidecar, "utf8"));
        await until(async () => JSON.parse(await readFile(sidecar, "utf8")).updatedAt !== before.updatedAt, 17_000);
        const after = JSON.parse(await readFile(sidecar, "utf8"));
        assert.equal(after.state, "rate-wait");
        assert.deepEqual(after.children, before.children);
        assert.equal(after.retryAt, before.retryAt);
        assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt));
      }
      const paid = fixture.requests.filter(request => request.rpc === "tools/call").length;
      if (cancellation === "parent-death") {
        const command = process.platform === "win32"
          ? await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`], { windowsHide: true })
          : await promisify(execFile)("ps", ["-o", "pid=", "--ppid", String(child.pid)]);
        const records = process.platform === "win32" ? [JSON.parse(command.stdout)].flat() as Array<{ ProcessId: number; Name: string; CommandLine: string }> : [];
        const pids = process.platform === "win32" ? records.filter(item => item.CommandLine?.includes("build-xydc-variant-data.ts")).map(item => item.ProcessId)
          : command.stdout.trim().split(/\s+/).map(Number).filter(Number.isSafeInteger);
        assert.equal(pids.length, 1, `expected one directly owned XYDC process: ${command.stdout}`);
        descendant = pids[0]!;
        tracked = process.platform === "win32" ? records.map(item => item.ProcessId) : pids;
        if (process.platform === "win32") {
          const grandchildren = await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${descendant}').ProcessId`], { windowsHide: true });
          tracked.push(...grandchildren.stdout.trim().split(/\s+/).map(Number).filter(value => Number.isSafeInteger(value) && value > 0));
          t.diagnostic(`Original runner children: ${records.map(item => item.Name).join(", ")}; tracked descendant processes: ${tracked.length}`);
        }
        child.kill("SIGKILL");
      } else if (cancellation === "sigterm") child.kill("SIGTERM");
      else await postgres.pool.query("UPDATE analysis_runs SET status='cancelled'");
      await Promise.race([closed, delay(5_000).then(() => { throw new Error("XYDC process did not close"); })]);
      if (descendant) await until(() => tracked.every(pid => !alive(pid)), 5_000);
      await delay(2_100);
      assert.equal(fixture.requests.filter(request => request.rpc === "tools/call").length, paid);
      if (cancellation === "parent-death") {
        assert.equal((await postgres.pool.query("SELECT status,lease_expires_at>now() AS valid FROM sync_jobs")).rows[0].valid, true);
        assert.equal(alive(descendant!), false);
      }
    } finally {
      if (child?.pid && alive(child.pid)) child.kill("SIGKILL");
      if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
      for (const pid of tracked) if (alive(pid)) process.kill(pid, "SIGKILL");
      await fixture.close(); await postgres.close();
    }
  });
}
