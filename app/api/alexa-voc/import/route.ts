import { saveAlexaVocToSystem } from "../../../../scripts/lib/alexa-voc-pipeline.mjs";
import { hasManualAlexaVocText } from "../../../alexa-voc-import-validation";
import { authorizeWebMutation } from "../../../lib/authenticated-web-mutation";
import { triggerBackgroundRebuild } from "../../../lib/trigger-rebuild";
import { resolveFormalWorktreeRoot } from "../../../../scripts/lib/formal-worktree-root.mjs";

type ImportPayload = { asin?: string; text?: string; autoRebuild?: boolean };
const MAX_IMPORT_BODY_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_REPORT_LINES = 1_000;
const MAX_REPORT_LINE_LENGTH = 2_048;
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

async function readBoundedBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BODY_BYTES) throw new RangeError("body");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_IMPORT_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("body");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

function reportLimit(text: string) {
  if (new TextEncoder().encode(text).byteLength > MAX_REPORT_BYTES) return "bytes";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.length > MAX_REPORT_LINES || lines.some((line) => line.length > MAX_REPORT_LINE_LENGTH)
    ? "structure"
    : null;
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
      const parsed = JSON.parse(await readBoundedBody(request)) as unknown;
      if (!isJsonObject(parsed)) return Response.json({ error: "请求内容必须是对象" }, { status: 400 });
      payload = parsed as ImportPayload;
    }
    catch (error) {
      return error instanceof RangeError && error.message === "body"
        ? Response.json({ error: "请求内容过大" }, { status: 413 })
        : Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
    }
    const asin = normalizeAsin(payload.asin);
    const text = String(payload.text ?? "").trim();
    if (!asin) return Response.json({ error: "ASIN 必须是 10 位编码" }, { status: 400 });
    if (!hasManualAlexaVocText(text)) return Response.json({ error: "Alexa 报告内容不能为空" }, { status: 400 });
    const limit = reportLimit(text);
    if (limit === "bytes") return Response.json({ error: "Alexa 报告内容过大" }, { status: 413 });
    if (limit === "structure") return Response.json({ error: "Alexa 报告结构超出限制" }, { status: 422 });
    let processed;
    try { processed = save(asin, text, { captureMode: "browser", worktree: resolveWorktree() }); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "empty_report") return Response.json({ error: "Alexa 报告内容不能为空" }, { status: 400 });
      if (code === "report_limits_bytes") return Response.json({ error: "Alexa 报告内容过大" }, { status: 413 });
      if (code.startsWith("report_limits_")) return Response.json({ error: "Alexa 报告结构超出限制" }, { status: 422 });
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
