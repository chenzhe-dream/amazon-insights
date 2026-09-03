import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ApiErrorResponseSchema,
  ChangePasswordRequestSchema,
  ChangePasswordResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutRequestSchema,
  LogoutResponseSchema,
  SessionResponseSchema,
  type ApiErrorCode,
} from "../../shared/agent-contracts";
import type { AgentAuthenticationConfig } from "../config";
import type { AuthenticationService } from "../auth/authentication-service";
import {
  parseSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "../auth/session";
import { ContractRouteError } from "./analysis-runs";

const RATE_LIMITED_MESSAGE = "Too many login attempts; try again later";
const INVALID_CREDENTIALS_MESSAGE = "Email or password is incorrect";

function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ContractRouteError(
    400,
    "VALIDATION_ERROR",
    "Request validation failed",
    parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "request",
      message: issue.message,
    })),
  );
}

function requireService(
  service: AuthenticationService | null,
): AuthenticationService {
  if (service) return service;
  throw new ContractRouteError(
    503,
    "CONFIGURATION_ERROR",
    "Authentication service is not configured",
  );
}

function publicError(
  code: ApiErrorCode,
  message: string,
  requestId: string,
) {
  return ApiErrorResponseSchema.parse({
    error: { code, message, requestId },
  });
}

function trustedSource(header: unknown): string {
  return typeof header === "string" && header.trim().length > 0
    ? header
    : "unknown-source";
}

function requestCookie(header: unknown): string | null {
  if (typeof header === "string") return header;
  return null;
}

export function registerPasswordRoute(
  app: FastifyInstance,
  service: AuthenticationService | null,
) {
  app.post("/v1/auth/password", async (request, reply) => {
    const principal = request.authPrincipal;
    if (!principal || principal.kind !== "user") {
      return reply.status(401).send(publicError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        request.id,
      ));
    }
    const body = parseContract(ChangePasswordRequestSchema, request.body);
    const result = await requireService(service).changePassword(principal, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
    if (result.status !== "changed") {
      return reply.status(401).send(publicError(
        "INVALID_CREDENTIALS",
        "Current password is incorrect",
        request.id,
      ));
    }
    return ChangePasswordResponseSchema.parse({ ok: true });
  });
}

export function registerAuthRoutes(
  app: FastifyInstance,
  service: AuthenticationService | null,
  config: AgentAuthenticationConfig,
) {
  app.post("/v1/auth/login", async (request, reply) => {
    const body = parseContract(LoginRequestSchema, request.body);
    const result = await requireService(service).login({
      email: body.email,
      password: body.password,
      source: trustedSource(request.headers["x-agent-client-ip"]),
    });

    if (result.status === "invalid-credentials") {
      return reply.status(401).send(
        publicError(
          "INVALID_CREDENTIALS",
          INVALID_CREDENTIALS_MESSAGE,
          request.id,
        ),
      );
    }

    if (result.status === "rate-limited") {
      return reply
        .status(429)
        .header("retry-after", String(result.retryAfterSeconds))
        .send(
          publicError(
            "LOGIN_RATE_LIMITED",
            RATE_LIMITED_MESSAGE,
            request.id,
          ),
        );
    }

    reply.header(
      "set-cookie",
      serializeSessionCookie(result.rawSessionToken, config.cookie),
    );
    return LoginResponseSchema.parse({ user: result.user });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    parseContract(LogoutRequestSchema, request.body ?? {});
    const rawToken = parseSessionCookie(
      requestCookie(request.headers.cookie),
      config.cookie,
    );
    await requireService(service).logout(rawToken);
    reply.header(
      "set-cookie",
      serializeClearedSessionCookie(config.cookie),
    );
    return LogoutResponseSchema.parse({ ok: true });
  });

  app.get("/v1/auth/session", async (request) => {
    const rawToken = parseSessionCookie(
      requestCookie(request.headers.cookie),
      config.cookie,
    );
    const authService = requireService(service);
    const principal = await authService.authenticate(rawToken);
    if (!principal) {
      return SessionResponseSchema.parse({
        authenticated: false,
        user: null,
        sessionIdentity: null,
      });
    }

    const user = await authService.findPublicUser(principal.userId);
    const sessionIdentity = createHash("sha256")
      .update(principal.sessionId, "utf8")
      .digest("base64url");
    return SessionResponseSchema.parse({
      authenticated: user !== null,
      user,
      sessionIdentity: user ? sessionIdentity : null,
    });
  });
}
