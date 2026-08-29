import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeWebMutation } from "../../../lib/authenticated-web-mutation";
import { normalizeAsins } from "../../../lib/sync-server";
import { triggerBackgroundRebuild } from "../../../lib/trigger-rebuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

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
    try {
      const payload = (await request.json()) as { asins?: unknown; marketplace?: string; rebuild?: boolean };
      const asins = normalizeAsins(payload.asins);
      if (!asins) return Response.json({ error: "asins must be 1–10 unique 10-char codes" }, { status: 400 });
      const marketplace = payload.marketplace?.trim().toUpperCase() || "US";
      const runner = path.join(root, "scripts", "run-alexa-voc-capture.mjs");
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
      const rebuildResult = payload.rebuild === true ? rebuild() : null;
      return Response.json(
        { ok: true, asins, message: "Alexa VOC 采集任务已在后台启动", rebuild: rebuildResult },
        { status: 202 },
      );
    } catch {
      return Response.json({ error: "sync start failed" }, { status: 500 });
    }
  };
}

export const POST = createAlexaVocSyncHandler();
