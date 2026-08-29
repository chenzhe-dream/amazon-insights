import { saveAlexaVocToSystem } from "../../../../scripts/lib/alexa-voc-pipeline.mjs";
import { hasManualAlexaVocText } from "../../../alexa-voc-import-validation";
import { triggerBackgroundRebuild } from "../../../lib/trigger-rebuild";

type ImportPayload = {
  asin?: string;
  text?: string;
  autoRebuild?: boolean;
};

function corsHeaders(origin?: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function normalizeAsin(value: unknown) {
  const asin = String(value ?? "")
    .trim()
    .toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  try {
    const payload = (await request.json()) as ImportPayload;
    const asin = normalizeAsin(payload.asin);
    const text = String(payload.text ?? "").trim();
    const autoRebuild = payload.autoRebuild !== false;

    if (!asin) {
      return Response.json({ error: "asin must be a 10-char code" }, { status: 400, headers });
    }
    if (!hasManualAlexaVocText(text)) {
      return Response.json({ error: "Alexa 报告内容不能为空" }, { status: 400, headers });
    }

    const processed = saveAlexaVocToSystem(asin, text, { captureMode: "browser" });
    const rebuild = autoRebuild ? triggerBackgroundRebuild() : { started: false, message: "skipped" };

    return Response.json(
      {
        ok: true,
        asin,
        filled: processed.filled,
        missing: processed.missing,
        overallConclusion: processed.overallConclusion,
        preview: {
          attention: processed.sections.attention.slice(0, 2),
          positives: processed.sections.positives.slice(0, 2),
          negatives: processed.sections.negatives.slice(0, 2),
        },
        rebuild,
        message: rebuild.started
          ? "已写入 VOC 数据，系统正在后台构建，约 1 分钟后刷新页面即可看到矩阵"
          : "已写入 VOC 数据",
      },
      { headers }
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "import failed" },
      { status: 500, headers }
    );
  }
}
