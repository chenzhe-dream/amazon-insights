import { fetchAsinDataStatus, normalizeAsins } from "../../../lib/sync-server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("asins");
  if (!raw?.trim()) {
    return Response.json({ error: "asins query required" }, { status: 400, headers: corsHeaders });
  }
  const asins = normalizeAsins(raw.split(","));
  if (!asins) {
    return Response.json({ error: "invalid asins" }, { status: 400, headers: corsHeaders });
  }
  const items = await fetchAsinDataStatus(asins);
  const pending = items.filter(item => item.voc === "missing").map(item => item.asin);
  return Response.json({ asins, pending, count: pending.length }, { headers: corsHeaders });
}
