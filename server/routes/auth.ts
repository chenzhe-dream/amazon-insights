import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  ApiErrorResponseSchema,
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

function strictSameSite(cookie: string): string {
  return cookie.replace(/SameSite=Lax\b/, "SameSite=Strict");
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
      strictSameSite(serializeSessionCookie(result.rawSessionToken, config.cookie)),
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
      strictSameSite(serializeClearedSessionCookie(config.cookie)),
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
      });
    }

    const user = await authService.findPublicUser(principal.userId);
    return SessionResponseSchema.parse({
      authenticated: user !== null,
      user,
    });
  });
}
