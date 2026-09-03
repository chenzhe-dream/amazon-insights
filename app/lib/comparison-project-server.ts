import "server-only";

import { z } from "zod";

import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  EntityIdSchema,
  GetProjectResponseSchema,
  LegacyProjectEligibilityResponseSchema,
  ListProjectsResponseSchema,
  ProjectCreationIdempotencyKeySchema,
  SessionResponseSchema,
  UpdateProjectRequestSchema,
  type Project,
  type User,
} from "../../shared/agent-contracts";
import { createProjectFavoriteStore } from "../../scripts/lib/project-favorite-store.mjs";
import {
  createAgentServiceClient,
  type AgentServiceResult,
} from "./agent-service-client";

const FavoriteKindSchema = z.enum([
  "analysis",
  "keyword-compare",
  "traffic-promo",
  "checklist",
]);
const CreateComparisonProjectSchema = CreateProjectRequestSchema.omit({ id: true }).extend({
  kind: FavoriteKindSchema,
  labels: z.array(z.string().trim().min(1).max(100)).max(20),
}).strict();

export type ProjectFavoriteRef = Readonly<{
  organizationId: string;
  agentProjectId: string;
  kind: z.infer<typeof FavoriteKindSchema>;
  slug: string;
  labels: readonly string[];
}>;

export type ComparisonAgentCall = Readonly<{
  method: "GET" | "POST" | "PATCH";
  path: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  requestId?: string;
}>;
export type ComparisonAgentClient = (
  call: ComparisonAgentCall,
) => Promise<AgentServiceResult<unknown>>;
export type ProjectFavoriteStore = Readonly<{
  list(organizationId: string): readonly ProjectFavoriteRef[];
  read(organizationId: string, agentProjectId: string): ProjectFavoriteRef | null;
  write(favorite: ProjectFavoriteRef): unknown;
  remove(organizationId: string, agentProjectId: string): boolean;
}>;
export type ComparisonProjectServerDependencies = Readonly<{
  client?: ComparisonAgentClient;
  favorites?: ProjectFavoriteStore;
}>;

type RouteContext = Readonly<{ params: Promise<{ projectId: string }> }>;
type SessionLookup =
  | Readonly<{ ok: true; user: User }>
  | Readonly<{ ok: false; response: Response }>;

function routeError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

function copyResponse(result: AgentServiceResult<unknown>) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["x-request-id", "retry-after"] as const) {
    const value = result.headers.get(name);
    if (value) headers.set(name, value);
  }
  return Response.json(result.body, { status: result.status, headers });
}

function serviceHeaders(request: Request, idempotencyKey?: string) {
  const headers = new Headers({ origin: new URL(request.url).origin });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
  return headers;
}

function sameOrigin(request: Request) {
  return request.headers.get("origin") === new URL(request.url).origin;
}

function favoriteSlug(name: string, projectId: string) {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "comparison";
  return `${base}-${projectId.slice(0, 8)}`;
}

function exactEcho(project: Project, organizationId: string, input: z.infer<typeof CreateComparisonProjectSchema>) {
  return project.organizationId === organizationId &&
    project.marketplace === input.marketplace &&
    project.asins.length === input.asins.length &&
    project.asins.every((asin, index) => asin === input.asins[index]);
}

export function createComparisonProjectServer(
  dependencies: ComparisonProjectServerDependencies = {},
) {
  const client = dependencies.client ??
    (createAgentServiceClient() as unknown as ComparisonAgentClient);
  const favorites = dependencies.favorites ??
    (createProjectFavoriteStore() as ProjectFavoriteStore);

  async function session(request: Request): Promise<SessionLookup> {
    const result = await client({
      method: "GET",
      path: "/v1/auth/session",
      headers: serviceHeaders(request),
      requestId: request.headers.get("x-request-id") ?? undefined,
    });
    if (result.status !== 200) return { ok: false, response: copyResponse(result) };
    const parsed = SessionResponseSchema.safeParse(result.body);
    if (!parsed.success) {
      return { ok: false, response: routeError(502, "AGENT_SERVICE_INVALID_RESPONSE", "Agent session response is invalid") };
    }
    if (!parsed.data.authenticated || !parsed.data.user) {
      return { ok: false, response: routeError(401, "AUTHENTICATION_REQUIRED", "Authentication is required") };
    }
    return { ok: true, user: parsed.data.user };
  }

  return Object.freeze({
    async create(request: Request) {
      if (!sameOrigin(request)) return routeError(403, "FORBIDDEN", "Request origin is not allowed");
      const rawKey = request.headers.get("idempotency-key");
      const key = ProjectCreationIdempotencyKeySchema.safeParse(rawKey);
      if (!key.success) return routeError(400, "VALIDATION_ERROR", "Idempotency-Key is invalid");
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return routeError(400, "VALIDATION_ERROR", "Request body is invalid");
      }
      const parsed = CreateComparisonProjectSchema.safeParse(raw);
      if (!parsed.success) return routeError(400, "VALIDATION_ERROR", "Request body is invalid");
      const identity = await session(request);
      if (!identity.ok) return identity.response;
      const agentBody = {
        name: parsed.data.name,
        marketplace: parsed.data.marketplace,
        asins: parsed.data.asins,
      };
      const result = await client({
        method: "POST",
        path: "/v1/projects",
        headers: serviceHeaders(request, key.data),
        body: JSON.stringify(agentBody),
        requestId: request.headers.get("x-request-id") ?? undefined,
      });
      if (result.status < 200 || result.status >= 300) return copyResponse(result);
      const created = CreateProjectResponseSchema.safeParse(result.body);
      if (!created.success || !exactEcho(created.data.project, identity.user.organizationId, parsed.data)) {
        return routeError(502, "AGENT_SERVICE_INVALID_RESPONSE", "Agent project echo is invalid");
      }
      try {
        favorites.write({
          organizationId: identity.user.organizationId,
          agentProjectId: created.data.project.id,
          kind: parsed.data.kind,
          slug: favoriteSlug(created.data.project.name, created.data.project.id),
          labels: parsed.data.labels,
        });
      } catch {
        return Response.json(
          { project: created.data.project, favorite: { saved: false, retryable: true } },
          { status: 503 },
        );
      }
      return Response.json(created.data, { status: result.status });
    },

    async list(request: Request) {
      const identity = await session(request);
      if (!identity.ok) return identity.response;
      const result = await client({
        method: "GET",
        path: "/v1/projects",
        headers: serviceHeaders(request),
        requestId: request.headers.get("x-request-id") ?? undefined,
      });
      if (result.status !== 200) return copyResponse(result);
      const listed = ListProjectsResponseSchema.safeParse(result.body);
      if (!listed.success || listed.data.projects.some(
        (project) => project.organizationId !== identity.user.organizationId,
      )) {
        return routeError(502, "AGENT_SERVICE_INVALID_RESPONSE", "Agent project list is invalid");
      }
      const refs = favorites.list(identity.user.organizationId);
      const projectIds = new Set(listed.data.projects.map((project) => project.id));
      const ownFavorites = refs.filter((favorite) => projectIds.has(favorite.agentProjectId));
      const legacyProjects: Array<ProjectFavoriteRef & { readOnly: true; importAllowed: true }> = [];
      for (const favorite of refs) {
        if (projectIds.has(favorite.agentProjectId)) continue;
        const eligibility = await client({
          method: "GET",
          path: `/v1/legacy-projects/${favorite.agentProjectId}/eligibility`,
          headers: serviceHeaders(request),
          requestId: request.headers.get("x-request-id") ?? undefined,
        });
        if (eligibility.status !== 200) continue;
        const eligible = LegacyProjectEligibilityResponseSchema.safeParse(eligibility.body);
        if (!eligible.success) continue;
        legacyProjects.push({ ...favorite, readOnly: true, importAllowed: true });
      }
      return Response.json({ projects: listed.data.projects, favorites: ownFavorites, legacyProjects });
    },

    async get(request: Request, context: RouteContext) {
      const params = EntityIdSchema.safeParse((await context.params).projectId);
      if (!params.success) return routeError(400, "VALIDATION_ERROR", "Project id is invalid");
      const identity = await session(request);
      if (!identity.ok) return identity.response;
      const result = await client({
        method: "GET",
        path: `/v1/projects/${params.data}`,
        headers: serviceHeaders(request),
        requestId: request.headers.get("x-request-id") ?? undefined,
      });
      if (result.status === 404) {
        const favorite = favorites.read(identity.user.organizationId, params.data);
        if (!favorite) return copyResponse(result);
        const eligibility = await client({
          method: "GET",
          path: `/v1/legacy-projects/${params.data}/eligibility`,
          headers: serviceHeaders(request),
          requestId: request.headers.get("x-request-id") ?? undefined,
        });
        const eligible = eligibility.status === 200
          ? LegacyProjectEligibilityResponseSchema.safeParse(eligibility.body)
          : null;
        if (!eligible?.success) {
          return routeError(404, "NOT_FOUND", "Project not found");
        }
        return Response.json({ legacyProject: { ...favorite, readOnly: true, importAllowed: true } });
      }
      if (result.status !== 200) return copyResponse(result);
      const found = GetProjectResponseSchema.safeParse(result.body);
      if (!found.success || found.data.project.organizationId !== identity.user.organizationId ||
        found.data.project.id !== params.data) {
        return routeError(502, "AGENT_SERVICE_INVALID_RESPONSE", "Agent project echo is invalid");
      }
      return Response.json(found.data);
    },

    async update(request: Request, context: RouteContext) {
      if (!sameOrigin(request)) return routeError(403, "FORBIDDEN", "Request origin is not allowed");
      const params = EntityIdSchema.safeParse((await context.params).projectId);
      if (!params.success) return routeError(400, "VALIDATION_ERROR", "Project id is invalid");
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return routeError(400, "VALIDATION_ERROR", "Request body is invalid");
      }
      const parsed = UpdateProjectRequestSchema.safeParse(raw);
      if (!parsed.success) return routeError(400, "VALIDATION_ERROR", "Request body is invalid");
      const identity = await session(request);
      if (!identity.ok) return identity.response;
      const result = await client({
        method: "PATCH",
        path: `/v1/projects/${params.data}`,
        headers: serviceHeaders(request),
        body: JSON.stringify(parsed.data),
        requestId: request.headers.get("x-request-id") ?? undefined,
      });
      if (result.status !== 200) return copyResponse(result);
      const updated = GetProjectResponseSchema.safeParse(result.body);
      if (!updated.success || updated.data.project.organizationId !== identity.user.organizationId ||
        updated.data.project.id !== params.data) {
        return routeError(502, "AGENT_SERVICE_INVALID_RESPONSE", "Agent project echo is invalid");
      }
      return Response.json(updated.data);
    },

    async removeFavorite(request: Request, context: RouteContext) {
      if (!sameOrigin(request)) return routeError(403, "FORBIDDEN", "Request origin is not allowed");
      const params = EntityIdSchema.safeParse((await context.params).projectId);
      if (!params.success) return routeError(400, "VALIDATION_ERROR", "Project id is invalid");
      const identity = await session(request);
      if (!identity.ok) return identity.response;
      return favorites.remove(identity.user.organizationId, params.data)
        ? Response.json({ removed: true })
        : routeError(404, "NOT_FOUND", "Favorite not found");
    },
  });
}
