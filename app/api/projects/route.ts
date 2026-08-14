import { createAnalysisProject, fetchProjects } from "../../lib/project-server";

export async function GET(request: Request) {
  try {
    const kind = new URL(request.url).searchParams.get("kind");
    const projects = await fetchProjects(
      kind === "analysis" || kind === "keyword-compare" || kind === "traffic-promo" || kind === "checklist" ? { kind } : undefined
    );
    return Response.json({ projects });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "list projects failed" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const project = await createAnalysisProject(payload);
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "create project failed";
    const status = message.includes("required") || message.includes("asins") ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}
