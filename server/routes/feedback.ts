import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import {
  CreateFeedbackRequestSchema,
  CreateFeedbackResponseSchema,
} from "../../shared/agent-contracts";
import type { UserFeedbackRepository } from "../db/repository";
import { ContractRouteError } from "./analysis-runs";

class BoundedFeedbackRateLimiter {
  readonly #buckets = new Map<string, number[]>();
  readonly #windowMs = 60_000;
  readonly #maxSubmissions = 5;
  readonly #maxEntries = 10_000;

  take(userId: string, now: number): boolean {
    for (const [key, timestamps] of this.#buckets) {
      const active = timestamps.filter((timestamp) => now - timestamp < this.#windowMs);
      if (active.length === 0) this.#buckets.delete(key);
      else this.#buckets.set(key, active);
    }
    const timestamps = this.#buckets.get(userId) ?? [];
    if (timestamps.length >= this.#maxSubmissions) return false;
    timestamps.push(now);
    this.#buckets.set(userId, timestamps);
    while (this.#buckets.size > this.#maxEntries) {
      const oldest = this.#buckets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#buckets.delete(oldest);
    }
    return true;
  }
}

function safePagePath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  const pathname = new URL(value, "http://local.invalid").pathname;
  return pathname.length <= 1_000 ? pathname : pathname.slice(0, 1_000);
}

export function registerFeedbackRoute(
  app: FastifyInstance,
  repository: UserFeedbackRepository | null,
  env: Readonly<Record<string, string | undefined>>,
) {
  const limiter = new BoundedFeedbackRateLimiter();
  app.post("/v1/feedback", async (request) => {
    const principal = request.authPrincipal;
    if (!principal || principal.kind !== "user") {
      throw new ContractRouteError(401, "AUTHENTICATION_REQUIRED", "Authentication is required");
    }
    if (!repository) {
      throw new ContractRouteError(503, "CONFIGURATION_ERROR", "Feedback storage is unavailable");
    }
    const body = CreateFeedbackRequestSchema.safeParse(request.body);
    if (!body.success) {
      throw new ContractRouteError(400, "VALIDATION_ERROR", "Request validation failed");
    }
    const createdAt = new Date().toISOString();
    if (!limiter.take(principal.userId, Date.parse(createdAt))) {
      throw new ContractRouteError(429, "RATE_LIMITED", "Too many feedback submissions");
    }
    const feedback = await repository.createUserFeedback({
      id: randomUUID(),
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      category: body.data.category,
      title: body.data.title,
      description: body.data.description,
      pagePath: safePagePath(body.data.pagePath),
      appVersion: env.npm_package_version?.trim().slice(0, 100) || null,
      createdAt,
    });
    if (!feedback) {
      throw new ContractRouteError(403, "FORBIDDEN", "Feedback submission is not authorized");
    }
    return CreateFeedbackResponseSchema.parse({
      feedbackId: feedback.id,
      createdAt: feedback.createdAt,
    });
  });
}
