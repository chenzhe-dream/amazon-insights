import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAsins } from "../../../lib/sync-server";
import { triggerBackgroundRebuild } from "../../../lib/trigger-rebuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { asins?: unknown; marketplace?: string; rebuild?: boolean };
    const asins = normalizeAsins(payload.asins);
    if (!asins) {
      return Response.json({ error: "asins must be 1–10 unique 10-char codes" }, { status: 400 });
    }

    const marketplace = payload.marketplace?.trim().toUpperCase() || "US";
    const runner = path.join(root, "scripts", "run-alexa-voc-capture.mjs");
    const child = spawn(
      process.execPath,
      [runner, ...asins],
      {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ALEXA_ASINS: asins.join(","),
          ALEXA_MARKETPLACE: marketplace,
          ALEXA_HEADLESS: process.env.ALEXA_HEADLESS ?? "1",
        },
      }
    );
    child.unref();

    const rebuild = payload.rebuild === true ? triggerBackgroundRebuild() : null;

    return Response.json(
      {
        ok: true,
        asins,
        message: "Alexa VOC 采集任务已在后台启动",
        rebuild,
      },
      { status: 202 }
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "sync start failed" },
      { status: 500 }
    );
  }
}
