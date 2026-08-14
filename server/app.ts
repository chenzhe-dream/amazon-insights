import { randomUUID } from "node:crypto";

import Fastify, { type FastifyServerOptions } from "fastify";

import { registerCapabilitiesRoutes } from "./routes/capabilities";
import type { ApiErrorCode } from "../shared/agent-contracts";

type BuildAgentAppOptions = Pick<FastifyServerOptions, "logger"> & {
  env?: Readonly<Record<string, string | undefined>>;
};

function errorCodeForStatus(statusCode: number): ApiErrorCode {
  switch (statusCode) {
    case 401:
      return "AUTHENTICATION_REQUIRED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "VALIDATION_ERROR";
  }
}

export function buildAgentApp(options: BuildAgentAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const structuredError = error as {
      message?: string;
      statusCode?: number;
    };
    const statusCode =
      typeof structuredError.statusCode === "number" &&
      structuredError.statusCode >= 400
        ? structuredError.statusCode
        : 500;

    reply.status(statusCode).send({
      error: {
        code: errorCodeForStatus(statusCode),
        message:
          statusCode >= 500
            ? "Internal server error"
            : (structuredError.message ?? "Request failed"),
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        requestId: request.id,
      },
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "agent-service",
  }));

  registerCapabilitiesRoutes(app, options.env);

  return app;
}
