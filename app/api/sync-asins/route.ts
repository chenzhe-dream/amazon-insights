import {
  fetchAsinDataStatus,
  normalizeAsins,
  startAsinSyncJob,
} from "../../lib/sync-server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("asins");
  if (!raw?.trim()) {
    return Response.json({ error: "asins query required" }, { status: 400 });
  }
  const asins = normalizeAsins(raw.split(","));
  if (!asins) {
    return Response.json({ error: "invalid asins" }, { status: 400 });
  }
  const items = await fetchAsinDataStatus(asins);
  const needsSync = items.some(
    item => item.keywords === "missing" || item.reviews === "missing" || item.sales === "missing"
  );
  const vocPending = items.filter(item => item.voc === "missing").map(item => item.asin);
  return Response.json({ asins, items, needsSync, vocPending });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { asins?: unknown; marketplace?: string };
    const asins = normalizeAsins(payload.asins);
    if (!asins) {
      return Response.json({ error: "asins must be 1–10 unique 10-char codes" }, { status: 400 });
    }
    const marketplace = payload.marketplace?.trim().toUpperCase() || "US";
    const result = await startAsinSyncJob(asins, marketplace);
    return Response.json(
      {
        jobId: result.job.jobId,
        status: result.job.status,
        message: result.job.message,
        mcpAsinsPending: result.mcpAsinsPending,
        estimatedAutoSeconds: result.estimatedAutoSeconds,
        estimatedAlexaSeconds: result.estimatedAlexaSeconds,
        stages: result.job.stages,
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
