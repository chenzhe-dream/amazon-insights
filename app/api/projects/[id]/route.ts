import { proxyAgentRequest } from "../../agent/[...path]/route";
import { authorizeWebMutation } from "../../../lib/authenticated-web-mutation";
import {
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

export async function DELETE(request: Request, context: RouteContext) {
  const authorization = await authorizeWebMutation(request, { allowedRoles: ["admin"] });
  if (!authorization.ok) return authorization.response;
  const { id } = await context.params;
  return proxyAgentRequest(request, { params: Promise.resolve({ path: ["v1", "local-data", "projects", id] }) });
}
