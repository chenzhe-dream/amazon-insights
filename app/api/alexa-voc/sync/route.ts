import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeWebMutation } from "../../../lib/authenticated-web-mutation";
import { normalizeAsins } from "../../../lib/sync-server";
import { triggerBackgroundRebuild } from "../../../lib/trigger-rebuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SyncDependencies = {
  authorize: typeof authorizeWebMutation;
  spawn: typeof spawn;
  rebuild: typeof triggerBackgroundRebuild;
};

export function createAlexaVocSyncHandler(dependencies: Partial<SyncDependencies> = {}) {
  const authorize = dependencies.authorize ?? authorizeWebMutation;
  const start = dependencies.spawn ?? spawn;
  const rebuild = dependencies.rebuild ?? triggerBackgroundRebuild;

  return async function handleAlexaVocSync(request: Request) {
    const authorization = await authorize(request, { allowedRoles: ["admin"] });
    if (!authorization.ok) return authorization.response;
    let payload: { asins?: unknown; marketplace?: unknown; rebuild?: unknown };
    try {
      const parsed = await request.json() as unknown;
      if (!isJsonObject(parsed)) return Response.json({ error: "请求内容必须是对象" }, { status: 400 });
      payload = parsed;
    } catch {
      return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
    }
    const asins = normalizeAsins(payload.asins);
    if (!asins) return Response.json({ error: "asins must be 1–10 unique 10-char codes" }, { status: 400 });
    const marketplace = typeof payload.marketplace === "string"
      ? payload.marketplace.trim().toUpperCase() || "US"
      : "US";
    const runner = path.join(root, "scripts", "run-alexa-voc-capture.mjs");
    try {
      const child = start(process.execPath, [runner, ...asins], {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ALEXA_ASINS: asins.join(","),
          ALEXA_MARKETPLACE: marketplace,
          ALEXA_HEADLESS: process.env.ALEXA_HEADLESS ?? "1",
        },
      });
      child.unref();
    } catch {
      return Response.json({ error: "sync start failed" }, { status: 500 });
    }
    let rebuildResult = null;
    try {
      rebuildResult = payload.rebuild === true ? rebuild() : null;
    } catch {
      return Response.json({ error: "Alexa VOC 后台构建失败" }, { status: 500 });
    }
    return Response.json(
      { ok: true, asins, message: "Alexa VOC 采集任务已在后台启动", rebuild: rebuildResult },
      { status: 202 },
    );
  };
}

export const POST = createAlexaVocSyncHandler();
