import { readJob } from "../../../lib/sync-server";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  const job = await readJob(jobId);
  if (!job) {
    return Response.json({ error: "job not found" }, { status: 404 });
  }
  return Response.json(job);
}
