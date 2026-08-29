import { saveAlexaVocToSystem } from "../../../../scripts/lib/alexa-voc-pipeline.mjs";
import { hasManualAlexaVocText } from "../../../alexa-voc-import-validation";
import { authorizeWebMutation } from "../../../lib/authenticated-web-mutation";
import { triggerBackgroundRebuild } from "../../../lib/trigger-rebuild";
import { resolveFormalWorktreeRoot } from "../../../../scripts/lib/formal-worktree-root.mjs";

type ImportPayload = { asin?: string; text?: string; autoRebuild?: boolean };
type ImportDependencies = {
  authorize: typeof authorizeWebMutation;
  save: typeof saveAlexaVocToSystem;
  rebuild: typeof triggerBackgroundRebuild;
  resolveWorktree: () => string;
};

function normalizeAsin(value: unknown) {
  const asin = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createAlexaVocImportHandler(dependencies: Partial<ImportDependencies> = {}) {
  const authorize = dependencies.authorize ?? authorizeWebMutation;
  const save = dependencies.save ?? saveAlexaVocToSystem;
  const rebuild = dependencies.rebuild ?? triggerBackgroundRebuild;
  const resolveWorktree = dependencies.resolveWorktree ?? (() => resolveFormalWorktreeRoot());

  return async function handleAlexaVocImport(request: Request) {
    const authorization = await authorize(request, { allowedRoles: ["admin", "member"] });
    if (!authorization.ok) return authorization.response;
    let payload: ImportPayload;
    try {
      const parsed = await request.json() as unknown;
      if (!isJsonObject(parsed)) return Response.json({ error: "请求内容必须是对象" }, { status: 400 });
      payload = parsed as ImportPayload;
    }
    catch { return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 }); }
    const asin = normalizeAsin(payload.asin);
    const text = String(payload.text ?? "").trim();
    if (!asin) return Response.json({ error: "ASIN 必须是 10 位编码" }, { status: 400 });
    if (!hasManualAlexaVocText(text)) return Response.json({ error: "Alexa 报告内容不能为空" }, { status: 400 });
    let processed;
    try { processed = save(asin, text, { captureMode: "browser", worktree: resolveWorktree() }); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "empty_report") return Response.json({ error: "Alexa 报告内容不能为空" }, { status: 400 });
      if (code === "asin_mismatch_report") return Response.json({ error: "Alexa 报告 ASIN 与所选 ASIN 不一致" }, { status: 422 });
      if (code.startsWith("incomplete_report")) return Response.json({ error: "Alexa 报告至少需要识别 3 个维度" }, { status: 422 });
      return Response.json({ error: "Alexa VOC 写入失败" }, { status: 500 });
    }
    let rebuildResult;
    try {
      rebuildResult = payload.autoRebuild === false ? { started: false, message: "skipped" } : rebuild();
    } catch {
      return Response.json({ error: "Alexa VOC 后台构建失败" }, { status: 500 });
    }
    return Response.json({
      ok: true, asin, filled: processed.filled, missing: processed.missing,
      overallConclusion: processed.overallConclusion,
      preview: {
        attention: processed.sections.attention.slice(0, 2),
        positives: processed.sections.positives.slice(0, 2),
        negatives: processed.sections.negatives.slice(0, 2),
      },
      rebuild: rebuildResult,
      message: rebuildResult.started ? "已写入 VOC 数据，正式页面正在后台发布" : "已写入 VOC 数据",
    });
  };
}

export const POST = createAlexaVocImportHandler();
