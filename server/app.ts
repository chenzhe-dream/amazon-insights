import { randomUUID } from "node:crypto";

import Fastify, { type FastifyServerOptions } from "fastify";

type BuildAgentAppOptions = Pick<FastifyServerOptions, "logger">;

export function buildAgentApp(options: BuildAgentAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: () => randomUUID(),
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    const structuredError = error as {
      code?: string;
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
        code:
          statusCode >= 500
            ? "INTERNAL_SERVER_ERROR"
            : (structuredError.code ?? "REQUEST_ERROR"),
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

  return app;
}
