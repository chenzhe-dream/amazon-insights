import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ChangeFeedbackStatusRequestSchema,
  CreateFeedbackTransferRequestSchema,
  CreateFeedbackRequestSchema,
  CreateFeedbackResponseSchema,
  FeedbackAdminListQuerySchema,
  FeedbackAttachmentParamsSchema,
  FeedbackDetailResponseSchema,
  FeedbackIdParamsSchema,
  FeedbackListResponseSchema,
  FeedbackUnreadCountResponseSchema,
  MarkFeedbackSeenRequestSchema,
  MarkFeedbackSeenResponseSchema,
  MAX_FEEDBACK_TRANSFER_BYTES,
} from "../../shared/agent-contracts";
import type { AuthenticatedPrincipal } from "../auth/authentication-service";
import type {
  FeedbackAttachmentRecord,
  UserFeedbackRepository,
} from "../db/repository";
import {
  sanitizeFeedbackImages,
  type FeedbackImageInput,
} from "../services/feedback-image-service";
import { ContractRouteError } from "./analysis-runs";

class BoundedFeedbackRateLimiter {
  readonly #buckets = new Map<string, { id: symbol; timestamp: number }[]>();
  readonly #windowMs = 60_000;
  readonly #maxSubmissions = 5;
  readonly #maxEntries = 10_000;

  reserve(userId: string, now: number): { release: () => void } | null {
    for (const [key, entries] of this.#buckets) {
      const active = entries.filter(
        (entry) => now - entry.timestamp < this.#windowMs,
      );
      if (active.length === 0) this.#buckets.delete(key);
      else this.#buckets.set(key, active);
    }

    const entries = this.#buckets.get(userId) ?? [];
    if (entries.length >= this.#maxSubmissions) return null;
    const id = Symbol("feedback-admission");
    entries.push({ id, timestamp: now });
    this.#buckets.set(userId, entries);

    while (this.#buckets.size > this.#maxEntries) {
      const oldest = this.#buckets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#buckets.delete(oldest);
    }

    return {
      release: () => {
        const current = this.#buckets.get(userId);
        if (!current) return;
        const remaining = current.filter((entry) => entry.id !== id);
        if (remaining.length === 0) this.#buckets.delete(userId);
        else this.#buckets.set(userId, remaining);
      },
    };
  }
}

function safePagePath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const pathname = new URL(value, "http://local.invalid").pathname;
    return pathname.length <= 1_000 ? pathname : pathname.slice(0, 1_000);
  } catch {
    return "/";
  }
}

function authenticated(request: FastifyRequest): AuthenticatedPrincipal {
  const principal = request.authPrincipal;
  if (!principal || principal.kind !== "user") {
    throw new ContractRouteError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication is required",
    );
  }
  return principal;
}

function primaryAdministrator(request: FastifyRequest): AuthenticatedPrincipal {
  const principal = authenticated(request);
  if (
    principal.role !== "admin" ||
    principal.email.trim().toLowerCase() !== "admin@example.com"
  ) {
    throw new ContractRouteError(403, "FORBIDDEN", "Request is not authorized");
  }
  return principal;
}

function requiredRepository(
  repository: UserFeedbackRepository | null,
): UserFeedbackRepository {
  if (!repository) {
    throw new ContractRouteError(
      503,
      "CONFIGURATION_ERROR",
      "Feedback storage is unavailable",
    );
  }
  return repository;
}

async function parseCreateRequest(request: FastifyRequest): Promise<{
  fields: ReturnType<typeof CreateFeedbackRequestSchema.parse>;
  images: FeedbackImageInput[];
}> {
  if (!request.isMultipart()) {
    if (request.headers["x-agent-feedback-transfer"] === "1") {
      const transfer = CreateFeedbackTransferRequestSchema.safeParse(request.body);
      if (!transfer.success) {
        throw new ContractRouteError(
          400,
          "VALIDATION_ERROR",
          "Request validation failed",
        );
      }
      const { images, ...fields } = transfer.data;
      return {
        fields,
        images: images.map((image) => ({
          fileName: image.fileName,
          declaredMediaType: image.mediaType,
          content: Buffer.from(image.contentBase64, "base64"),
        })),
      };
    }
    const body = CreateFeedbackRequestSchema.safeParse(request.body);
    if (!body.success) {
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
      );
    }
    return { fields: body.data, images: [] };
  }

  const fields: Record<string, unknown> = {};
  const images: FeedbackImageInput[] = [];
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "images") {
          throw new Error("Unexpected multipart file field");
        }
        images.push({
          fileName: part.filename,
          declaredMediaType: part.mimetype,
          content: await part.toBuffer(),
        });
      } else {
        if (
          part.fieldnameTruncated ||
          part.valueTruncated ||
          Object.hasOwn(fields, part.fieldname)
        ) {
          throw new Error("Invalid multipart field");
        }
        fields[part.fieldname] = part.value;
      }
    }
  } catch {
    throw new ContractRouteError(
      400,
      "VALIDATION_ERROR",
      "Request validation failed",
    );
  }

  const body = CreateFeedbackRequestSchema.safeParse(fields);
  if (!body.success) {
    throw new ContractRouteError(
      400,
      "VALIDATION_ERROR",
      "Request validation failed",
    );
  }
  return { fields: body.data, images };
}

function sendAttachment(
  reply: FastifyReply,
  attachment: FeedbackAttachmentRecord | null,
) {
  if (!attachment) {
    throw new ContractRouteError(
      404,
      "NOT_FOUND",
      "Feedback attachment was not found",
    );
  }
  reply
    .header("content-type", attachment.mediaType)
    .header("content-length", String(attachment.imageContent.byteLength))
    .header("content-disposition", attachmentContentDisposition(attachment.fileName))
    .header("x-content-type-options", "nosniff")
    .header("cache-control", "private, max-age=300, no-transform");
  return reply.send(Readable.from([attachment.imageContent]));
}

function attachmentContentDisposition(fileName: string): string {
  const safeFileName = fileName.replace(/[\u0000-\u001f\u007f]/gu, "_") || "feedback-image";
  const fallback = safeFileName.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  if (fallback === safeFileName) return `inline; filename="${fallback}"`;

  const encoded = [...Buffer.from(safeFileName, "utf8")]
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(character)
        ? character
        : `%${byte.toString(16).padStart(2, "0").toUpperCase()}`;
    })
    .join("");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function registerFeedbackRoute(
  app: FastifyInstance,
  repository: UserFeedbackRepository | null,
  env: Readonly<Record<string, string | undefined>>,
) {
  const limiter = new BoundedFeedbackRateLimiter();

  app.post("/v1/feedback", {
    bodyLimit: MAX_FEEDBACK_TRANSFER_BYTES,
  }, async (request) => {
    const principal = authenticated(request);
    const store = requiredRepository(repository);
    const createdAt = new Date().toISOString();
    const admission = limiter.reserve(principal.userId, Date.parse(createdAt));
    if (!admission) {
      throw new ContractRouteError(
        429,
        "RATE_LIMITED",
        "Too many feedback submissions",
      );
    }

    let parsed: Awaited<ReturnType<typeof parseCreateRequest>>;
    try {
      parsed = await parseCreateRequest(request);
    } catch (error) {
      admission.release();
      throw error;
    }

    let sanitized;
    try {
      sanitized = await sanitizeFeedbackImages(parsed.images);
    } catch {
      admission.release();
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
      );
    }

    const feedback = await store.createUserFeedback({
      id: randomUUID(),
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      category: parsed.fields.category,
      title: parsed.fields.title,
      description: parsed.fields.description,
      pagePath: safePagePath(parsed.fields.pagePath),
      appVersion: env.npm_package_version?.trim().slice(0, 100) || null,
      createdAt,
      initialEventId: randomUUID(),
      attachments: sanitized.map((attachment) => ({
        ...attachment,
        id: randomUUID(),
        createdAt,
      })),
    });
    if (!feedback) {
      throw new ContractRouteError(
        403,
        "FORBIDDEN",
        "Feedback submission is not authorized",
      );
    }
    return CreateFeedbackResponseSchema.parse({
      feedbackId: feedback.id,
      createdAt: feedback.createdAt,
    });
  });

  app.get("/v1/feedback/mine", async (request) => {
    const principal = authenticated(request);
    const feedback = await requiredRepository(repository).listOwnFeedback({
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
    });
    return FeedbackListResponseSchema.parse({ feedback });
  });

  app.get("/v1/feedback/mine/:feedbackId", async (request) => {
    const principal = authenticated(request);
    const params = FeedbackIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
      );
    }
    const feedback = await requiredRepository(repository).getOwnFeedbackDetail({
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      feedbackId: params.data.feedbackId,
    });
    if (!feedback) {
      throw new ContractRouteError(404, "NOT_FOUND", "Feedback was not found");
    }
    return FeedbackDetailResponseSchema.parse({ feedback });
  });

  app.get(
    "/v1/feedback/mine/:feedbackId/attachments/:attachmentId",
    async (request, reply) => {
      const principal = authenticated(request);
      const params = FeedbackAttachmentParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ContractRouteError(
          400,
          "VALIDATION_ERROR",
          "Request validation failed",
        );
      }
      const attachment = await requiredRepository(
        repository,
      ).readOwnFeedbackAttachment({
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        ...params.data,
      });
      return sendAttachment(reply, attachment);
    },
  );

  app.get("/v1/feedback/admin", async (request) => {
    const principal = primaryAdministrator(request);
    const query = FeedbackAdminListQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
      );
    }
    const feedback = await requiredRepository(
      repository,
    ).listOrganizationFeedback({
      organizationId: principal.organizationId,
      status: query.data.status ?? null,
    });
    return FeedbackListResponseSchema.parse({ feedback });
  });

  app.get("/v1/feedback/admin/unread-count", async (request) => {
    const principal = primaryAdministrator(request);
    const count = await requiredRepository(
      repository,
    ).countUnreadOrganizationFeedback(principal.organizationId);
    return FeedbackUnreadCountResponseSchema.parse({ count });
  });

  app.get("/v1/feedback/admin/:feedbackId", async (request) => {
    const principal = primaryAdministrator(request);
    const params = FeedbackIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
      );
    }
    const feedback = await requiredRepository(
      repository,
    ).getOrganizationFeedbackDetail({
      organizationId: principal.organizationId,
      feedbackId: params.data.feedbackId,
    });
    if (!feedback) {
      throw new ContractRouteError(404, "NOT_FOUND", "Feedback was not found");
    }
    return FeedbackDetailResponseSchema.parse({ feedback });
  });

  app.get(
    "/v1/feedback/admin/:feedbackId/attachments/:attachmentId",
    async (request, reply) => {
      const principal = primaryAdministrator(request);
      const params = FeedbackAttachmentParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ContractRouteError(
          400,
          "VALIDATION_ERROR",
          "Request validation failed",
        );
      }
      const attachment = await requiredRepository(
        repository,
      ).readOrganizationFeedbackAttachment({
        organizationId: principal.organizationId,
        ...params.data,
      });
      return sendAttachment(reply, attachment);
    },
  );

  app.post("/v1/feedback/admin/:feedbackId/mark-seen", async (request) => {
    const principal = primaryAdministrator(request);
    const params = FeedbackIdParamsSchema.safeParse(request.params);
    const body = MarkFeedbackSeenRequestSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
      );
    }
    const result = await requiredRepository(
      repository,
    ).markOrganizationFeedbackSeen({
      organizationId: principal.organizationId,
      feedbackId: params.data.feedbackId,
      seenAt: new Date().toISOString(),
    });
    if (result === null) {
      throw new ContractRouteError(404, "NOT_FOUND", "Feedback was not found");
    }
    return MarkFeedbackSeenResponseSchema.parse({ seen: result === "changed" });
  });

  app.post("/v1/feedback/admin/:feedbackId/status", async (request) => {
    const principal = primaryAdministrator(request);
    const params = FeedbackIdParamsSchema.safeParse(request.params);
    const body = ChangeFeedbackStatusRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      throw new ContractRouteError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
      );
    }
    const store = requiredRepository(repository);
    const changed = await store.changeOrganizationFeedbackStatus({
      organizationId: principal.organizationId,
      feedbackId: params.data.feedbackId,
      actorUserId: principal.userId,
      expectedVersion: body.data.expectedVersion,
      status: body.data.status,
      eventId: randomUUID(),
      changedAt: new Date().toISOString(),
    });
    if (!changed) {
      const existing = await store.getOrganizationFeedbackDetail({
        organizationId: principal.organizationId,
        feedbackId: params.data.feedbackId,
      });
      if (!existing) {
        throw new ContractRouteError(
          404,
          "NOT_FOUND",
          "Feedback was not found",
        );
      }
      throw new ContractRouteError(
        409,
        "CONFLICT",
        "Feedback status changed concurrently",
      );
    }
    const feedback = await store.getOrganizationFeedbackDetail({
      organizationId: principal.organizationId,
      feedbackId: params.data.feedbackId,
    });
    if (!feedback) {
      throw new ContractRouteError(404, "NOT_FOUND", "Feedback was not found");
    }
    return FeedbackDetailResponseSchema.parse({ feedback });
  });
}
