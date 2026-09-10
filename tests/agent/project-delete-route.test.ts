import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("web project DELETE validates session and origin before touching isolated project storage", async t => {
  const root = mkdtempSync(join(tmpdir(), "project-delete-"));
  const keys = ["AGENT_DATA_ROOT", "AGENT_SERVICE_INTERNAL_URL", "AGENT_SERVICE_PROXY_TOKEN"] as const;
  const previous = keys.map(key => process.env[key]);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    rmSync(root, { recursive: true, force: true });
  });
  process.env.AGENT_DATA_ROOT = root;
  process.env.AGENT_SERVICE_INTERNAL_URL = "http://127.0.0.1:39999";
  process.env.AGENT_SERVICE_PROXY_TOKEN = "test-token";
  const id = "10000000-0000-4000-8000-000000000001";
  mkdirSync(join(root, "projects"));
  const file = join(root, "projects", `${id}.json`);
  writeFileSync(file, JSON.stringify({ id, kind: "analysis", createdBy: "Admin" }));
  let owned = true;
  let role: "admin" | "member" | null = "member";
  globalThis.fetch = async (input, init) => {
    if (init?.method === "DELETE") {
      assert.match(String(input), /\/v1\/local-data\/projects\//);
      assert.equal(role, "admin");
      if (!owned) return Response.json({ error: { code: "FORBIDDEN", message: "项目归属不可验证", requestId: "test" } }, { status: 403 });
      if (!existsSync(file)) return Response.json({ error: { code: "NOT_FOUND", message: "Project not found", requestId: "test" } }, { status: 404 });
      unlinkSync(file);
      return Response.json({ ok: true });
    }
    return Response.json({ authenticated: role !== null,
    sessionIdentity: role ? "S".repeat(43) : null,
    user: role ? { id, organizationId: "10000000-0000-4000-8000-000000000002", email: "test@example.com", displayName: "Test", role, status: "active", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" } : null });
  };
  const { DELETE } = await import("../../app/api/projects/[id]/route");
  const remove = (origin = "http://localhost") => DELETE(new Request(`http://localhost/api/projects/${id}`, { method: "DELETE", headers: { origin, cookie: "agent_session=test" } }), { params: Promise.resolve({ id }) });
  assert.equal((await remove()).status, 403);
  assert.ok(existsSync(file));
  role = null;
  assert.equal((await remove()).status, 401);
  assert.ok(existsSync(file));
  role = "admin";
  assert.equal((await remove("https://foreign.example")).status, 403);
  assert.ok(existsSync(file));
  owned = false;
  assert.equal((await remove()).status, 403);
  assert.ok(existsSync(file));
  owned = true;
  assert.equal((await remove()).status, 200);
  assert.equal(existsSync(file), false);
  assert.equal((await remove()).status, 404);
});
