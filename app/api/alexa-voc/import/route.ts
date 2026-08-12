import { saveAlexaVocToSystem } from "../../../../scripts/lib/alexa-voc-pipeline.mjs";

type ImportPayload = {
  asin?: string;
  text?: string;
};

function normalizeAsin(value: unknown) {
  const asin = String(value ?? "")
    .trim()
    .toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as ImportPayload;
    const asin = normalizeAsin(payload.asin);
    const text = String(payload.text ?? "").trim();

    if (!asin) {
      return Response.json({ error: "asin must be a 10-char code" }, { status: 400 });
    }
    if (text.length < 600) {
      return Response.json({ error: "text too short · 请粘贴完整 Alexa 七问报告" }, { status: 400 });
    }

    const processed = saveAlexaVocToSystem(asin, text, { captureMode: "paste" });

    return Response.json({
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
      message: "已写入 app/rufus-voc-data.ts · 请运行 npm run build 并重启团队服务",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "import failed" },
      { status: 500 }
    );
  }
}
