import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  ApiErrorResponseSchema,
  DingTalkOAuthCallbackRequestSchema,
  DingTalkOAuthCallbackResponseSchema,
  DingTalkOAuthStartRequestSchema,
  DingTalkOAuthStartResponseSchema,
  DingTalkPublicConfigResponseSchema,
  DingTalkWorkbenchLoginRequestSchema,
  DingTalkWorkbenchLoginResponseSchema,
  type ApiErrorCode,
} from "../../shared/agent-contracts";
import type { AgentAuthenticationConfig } from "../config";
import {
  DingTalkAuthenticationError,
  type DingTalkAuthenticationService,
} from "../auth/dingtalk-authentication-service";
import { DingTalkProviderError } from "../auth/dingtalk-provider";
import {
  parseDingTalkOAuthStateCookie,
  serializeClearedDingTalkOAuthStateCookie,
  serializeDingTalkOAuthStateCookie,
} from "../auth/dingtalk-state-cookie";
import { serializeSessionCookie } from "../auth/session";
import { ContractRouteError } from "./analysis-runs";

type PublicFailure = Readonly<{
  status: number;
  code: ApiErrorCode;
  message: string;
}>;

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

function publicError(code: ApiErrorCode, message: string, requestId: string) {
  return ApiErrorResponseSchema.parse({ error: { code, message, requestId } });
}

function sendFailure(reply: FastifyReply, requestId: string, failure: PublicFailure) {
  return reply
    .status(failure.status)
    .send(publicError(failure.code, failure.message, requestId));
}

function mappedFailure(error: unknown): PublicFailure | null {
  if (error instanceof DingTalkAuthenticationError) {
    switch (error.category) {
      case "invalid-state":
        return { status: 400, code: "DINGTALK_INVALID_STATE", message: "DingTalk login state is invalid or expired" };
      case "disabled-user":
        return { status: 403, code: "DINGTALK_DISABLED", message: "This account is disabled" };
      case "tenant-mismatch":
        return { status: 403, code: "DINGTALK_NOT_MEMBER", message: "DingTalk enterprise membership is required" };
      case "disabled":
        return { status: 503, code: "DINGTALK_DISABLED", message: "DingTalk authentication is disabled" };
      case "unavailable":
        return { status: 503, code: "DINGTALK_UNAVAILABLE", message: "DingTalk authentication is temporarily unavailable" };
    }
  }
  if (error instanceof DingTalkProviderError) {
    switch (error.category) {
      case "invalid-code":
        return { status: 401, code: "DINGTALK_INVALID_CODE", message: "DingTalk authorization code is invalid or expired" };
      case "not-member":
      case "tenant-mismatch":
        return { status: 403, code: "DINGTALK_NOT_MEMBER", message: "DingTalk enterprise membership is required" };
      case "inactive-member":
        return { status: 403, code: "DINGTALK_DISABLED", message: "This DingTalk member is inactive" };
      case "unavailable":
        return { status: 503, code: "DINGTALK_UNAVAILABLE", message: "DingTalk authentication is temporarily unavailable" };
    }
  }
  return null;
}

function requireService(service: DingTalkAuthenticationService | null) {
  if (service) return service;
  throw new DingTalkAuthenticationError("disabled");
}

export function registerDingTalkAuthRoutes(
  app: FastifyInstance,
  service: DingTalkAuthenticationService | null,
  authConfig: AgentAuthenticationConfig,
) {
  const stateCookieProfile = { secure: authConfig.cookie.secure } as const;

  app.get("/v1/auth/dingtalk/config", async () =>
    DingTalkPublicConfigResponseSchema.parse(
      service?.publicConfig() ?? { enabled: false },
    ));

  app.post("/v1/auth/dingtalk/workbench", async (request, reply) => {
    const body = parseContract(DingTalkWorkbenchLoginRequestSchema, request.body);
    try {
      const result = await requireService(service).loginWorkbench(body.code);
      reply.header(
        "set-cookie",
        serializeSessionCookie(result.rawSessionToken, authConfig.cookie),
      );
      return DingTalkWorkbenchLoginResponseSchema.parse({ user: result.user });
    } catch (error) {
      const failure = mappedFailure(error);
      if (!failure) throw error;
      return sendFailure(reply, request.id, failure);
    }
  });

  app.post("/v1/auth/dingtalk/oauth/start", async (request, reply) => {
    const body = parseContract(DingTalkOAuthStartRequestSchema, request.body);
    try {
      const result = await requireService(service).startOAuth(body.returnPath);
      reply.header(
        "set-cookie",
        serializeDingTalkOAuthStateCookie(result.rawState, stateCookieProfile),
      );
      return DingTalkOAuthStartResponseSchema.parse({
        authorizationUrl: result.authorizationUrl,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      const failure = mappedFailure(error);
      if (!failure) throw error;
      return sendFailure(reply, request.id, failure);
    }
  });

  app.post("/v1/auth/dingtalk/oauth/callback", async (request, reply) => {
    const body = parseContract(DingTalkOAuthCallbackRequestSchema, request.body);
    const clearedStateCookie = serializeClearedDingTalkOAuthStateCookie(stateCookieProfile);
    reply.header("set-cookie", clearedStateCookie);
    try {
      const result = await requireService(service).completeOAuth({
        code: body.code,
        state: body.state,
        cookieState: parseDingTalkOAuthStateCookie(
          typeof request.headers.cookie === "string" ? request.headers.cookie : null,
          stateCookieProfile,
        ),
      });
      reply.removeHeader("set-cookie");
      reply.header("set-cookie", [
        clearedStateCookie,
        serializeSessionCookie(result.rawSessionToken, authConfig.cookie),
      ]);
      return DingTalkOAuthCallbackResponseSchema.parse({
        user: result.user,
        returnPath: result.returnPath,
      });
    } catch (error) {
      const failure = mappedFailure(error);
      if (!failure) throw error;
      return sendFailure(reply, request.id, failure);
    }
  });
}
