import {
  deleteAnalysisProject,
  fetchProject,
  updateAnalysisProject,
} from "../../../lib/project-server";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const project = await fetchProject(id);
  if (!project) {
    return Response.json({ error: "project not found" }, { status: 404 });
  }
  return Response.json({ project });
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const project = await updateAnalysisProject(id, payload);
    if (!project) {
      return Response.json({ error: "project not found" }, { status: 404 });
    }
    return Response.json({ project });
  } catch (error) {
    const message = error instanceof Error ? error.message : "update project failed";
    const status = message.includes("empty") || message.includes("asins") ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const ok = await deleteAnalysisProject(id);
  if (!ok) {
    return Response.json({ error: "project not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
