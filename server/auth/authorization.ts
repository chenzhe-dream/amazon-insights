import type { FastifyRequest } from "fastify";

import type { AuthenticatedPrincipal } from "./authentication-service";
import type { AnalysisRunService } from "../services/analysis-run-service";

export type AnonymousLoopbackPrincipal = Readonly<{
  kind: "anonymous-loopback";
}>;

export type RequestPrincipal =
  | AuthenticatedPrincipal
  | AnonymousLoopbackPrincipal;

export type RouteAccess =
  | Readonly<{ kind: "public" }>
  | Readonly<{ kind: "proxy-only" }>
  | Readonly<{ kind: "session"; roles: readonly ("admin" | "member")[] }>
  | Readonly<{
      kind: "session-or-anonymous-loopback";
      roles: readonly ("admin" | "member")[];
    }>;

export type AnalysisRunServiceResolver = (
  principal: RequestPrincipal,
) => AnalysisRunService | null;

declare module "fastify" {
  interface FastifyRequest {
    authPrincipal: RequestPrincipal | null;
  }
}

const MEMBER_ROLES = Object.freeze(["admin", "member"] as const);
const ADMIN_ROLES = Object.freeze(["admin"] as const);
const UUID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const ANONYMOUS_FIXTURE_ROUTES: readonly Readonly<{
  method: string;
  pattern: RegExp;
}>[] = [
  { method: "POST", pattern: /^\/v1\/local-voc$/ },
  {
    method: "POST",
    pattern: new RegExp(`^/v1/runs/${UUID}/voc-import$`),
  },
  { method: "GET", pattern: new RegExp(`^/v1/runs/${UUID}$`) },
  { method: "GET", pattern: new RegExp(`^/v1/runs/${UUID}/reports$`) },
  { method: "GET", pattern: new RegExp(`^/v1/reports/${UUID}$`) },
  { method: "GET", pattern: /^\/v1\/local-data\/fixture$/ },
];

export function classifyRoute(method: string, pathname: string): RouteAccess {
  const normalizedMethod = method.toUpperCase();

  if (normalizedMethod === "GET" && pathname === "/health") {
    return { kind: "public" };
  }

  if (
    (normalizedMethod === "POST" && pathname === "/v1/auth/login") ||
    (normalizedMethod === "POST" && pathname === "/v1/auth/logout") ||
    (normalizedMethod === "GET" && pathname === "/v1/auth/session")
  ) {
    return { kind: "proxy-only" };
  }

  if (
    normalizedMethod === "GET" &&
    pathname === "/v1/capabilities"
  ) {
    return { kind: "session-or-anonymous-loopback", roles: MEMBER_ROLES };
  }

  if (
    ANONYMOUS_FIXTURE_ROUTES.some(
      (route) =>
        route.method === normalizedMethod && route.pattern.test(pathname),
    )
  ) {
    return { kind: "session-or-anonymous-loopback", roles: MEMBER_ROLES };
  }

  if (
    (normalizedMethod === "GET" && pathname === "/v1/connectors") ||
    (normalizedMethod === "POST" &&
      new RegExp(`^/v1/connectors/${connectorIdPattern()}/probe$`).test(pathname)) ||
    ((normalizedMethod === "PUT" || normalizedMethod === "DELETE") &&
      new RegExp(`^/v1/connectors/${connectorIdPattern()}/credential$`).test(pathname))
  ) {
    return { kind: "session", roles: ADMIN_ROLES };
  }

  if (
    (normalizedMethod === "GET" && pathname === "/v1/admin/concurrency") ||
    (normalizedMethod === "PUT" && pathname === "/v1/admin/concurrency/policy") ||
    (normalizedMethod === "PUT" && pathname === "/v1/admin/seller-sprite/quota/total") ||
    (normalizedMethod === "POST" && pathname === "/v1/admin/seller-sprite/quota/refresh") ||
    (normalizedMethod === "POST" && pathname === "/v1/admin/concurrency/pause") ||
    (normalizedMethod === "POST" &&
      new RegExp(`^/v1/admin/connectors/${connectorIdPattern()}/circuit/reset$`).test(pathname))
  ) {
    return { kind: "session", roles: ADMIN_ROLES };
  }

  if (/^\/v1\/feedback\/admin(?:\/|$)/.test(pathname)) {
    return { kind: "session", roles: ADMIN_ROLES };
  }

  return { kind: "session", roles: MEMBER_ROLES };
}

export function requireRole(
  principal: RequestPrincipal,
  allowedRoles: readonly ("admin" | "member")[],
): void {
  if (principal.kind !== "user" || !allowedRoles.includes(principal.role)) {
    throw new Error("Forbidden");
  }
}

export function requestPathname(request: FastifyRequest): string {
  return new URL(request.url, "http://agent-service.local").pathname;
}

function connectorIdPattern(): string {
  return "[A-Za-z][A-Za-z0-9-]{0,63}";
}
