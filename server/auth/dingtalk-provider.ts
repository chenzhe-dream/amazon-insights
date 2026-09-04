import { z } from "zod";

import type { DingTalkAuthenticationConfig } from "../config";

const APP_ACCESS_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const USER_ACCESS_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/userAccessToken";
const CURRENT_USER_URL = "https://api.dingtalk.com/v1.0/contact/users/me";
const WORKBENCH_USER_URL = "https://oapi.dingtalk.com/topapi/v2/user/getuserinfo";
const UNION_USER_URL = "https://oapi.dingtalk.com/topapi/user/getbyunionid";
const MEMBER_DETAIL_URL = "https://oapi.dingtalk.com/topapi/v2/user/get";

const accessTokenSchema = z.object({
  accessToken: z.string().trim().min(1).max(4_096),
  expireIn: z.number().int().positive().optional(),
});
const currentUserSchema = z.object({
  unionId: z.string().trim().min(1).max(200),
});
const classicResponseSchema = z.object({
  errcode: z.number().int(),
  errmsg: z.string().optional(),
  result: z.unknown().optional(),
});
const userIdResultSchema = z.object({
  userid: z.string().trim().min(1).max(200),
});
const memberResultSchema = z.object({
  userid: z.string().trim().min(1).max(200),
  unionid: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320).optional().nullable(),
  active: z.boolean(),
});

export type DingTalkProviderErrorCategory =
  | "invalid-code"
  | "not-member"
  | "inactive-member"
  | "tenant-mismatch"
  | "unavailable";

export class DingTalkProviderError extends Error {
  constructor(readonly category: DingTalkProviderErrorCategory) {
    super(category === "unavailable"
      ? "DingTalk identity provider is unavailable"
      : `DingTalk identity verification failed: ${category}`);
    this.name = "DingTalkProviderError";
  }
}

export interface VerifiedDingTalkIdentity {
  readonly corpId: string;
  readonly subjectId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly active: boolean;
}

export interface DingTalkIdentityProvider {
  exchangeWorkbenchCode(code: string): Promise<VerifiedDingTalkIdentity>;
  exchangeOAuthCode(code: string): Promise<VerifiedDingTalkIdentity>;
}

type EnabledDingTalkConfig = Extract<
  DingTalkAuthenticationConfig,
  { enabled: true }
>;

export interface RemoteDingTalkIdentityProviderOptions {
  readonly config: EnabledDingTalkConfig;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class RemoteDingTalkIdentityProvider
  implements DingTalkIdentityProvider {
  readonly #config: EnabledDingTalkConfig;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: RemoteDingTalkIdentityProviderOptions) {
    this.#config = options.config;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 65_536;
    if (
      !Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 ||
      !Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1
    ) {
      throw new TypeError("Invalid DingTalk provider limits");
    }
  }

  async exchangeWorkbenchCode(code: string): Promise<VerifiedDingTalkIdentity> {
    try {
      const normalizedCode = normalizeCode(code);
      const appToken = await this.#applicationAccessToken();
      const response = await this.#classicPost(
        WORKBENCH_USER_URL,
        appToken,
        { code: normalizedCode },
      );
      if (response.errcode !== 0) throw new DingTalkProviderError("invalid-code");
      const result = userIdResultSchema.safeParse(response.result);
      if (!result.success) throw new DingTalkProviderError("invalid-code");
      return await this.#memberIdentity(appToken, result.data.userid);
    } catch (error) {
      throw stableProviderError(error);
    }
  }

  async exchangeOAuthCode(code: string): Promise<VerifiedDingTalkIdentity> {
    try {
      const normalizedCode = normalizeCode(code);
      const tokenPayload = await this.#requestJson(USER_ACCESS_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: this.#config.clientId,
          clientSecret: this.#config.clientSecret,
          code: normalizedCode,
          grantType: "authorization_code",
        }),
      });
      const userToken = accessTokenSchema.safeParse(tokenPayload);
      if (!userToken.success) throw new DingTalkProviderError("invalid-code");

      const currentPayload = await this.#requestJson(CURRENT_USER_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${userToken.data.accessToken}` },
      });
      const current = currentUserSchema.parse(currentPayload);
      const appToken = await this.#applicationAccessToken();
      const resolution = await this.#classicPost(
        UNION_USER_URL,
        appToken,
        { unionid: current.unionId },
      );
      if (resolution.errcode !== 0) throw new DingTalkProviderError("not-member");
      const memberId = userIdResultSchema.safeParse(resolution.result);
      if (!memberId.success) throw new DingTalkProviderError("not-member");
      return await this.#memberIdentity(
        appToken,
        memberId.data.userid,
        current.unionId,
      );
    } catch (error) {
      throw stableProviderError(error);
    }
  }

  async #applicationAccessToken(): Promise<string> {
    const payload = await this.#requestJson(APP_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appKey: this.#config.clientId,
        appSecret: this.#config.clientSecret,
      }),
    });
    return accessTokenSchema.parse(payload).accessToken;
  }

  async #memberIdentity(
    appToken: string,
    userId: string,
    expectedUnionId?: string,
  ): Promise<VerifiedDingTalkIdentity> {
    const response = await this.#classicPost(
      MEMBER_DETAIL_URL,
      appToken,
      { userid: userId, language: "zh_CN" },
    );
    if (response.errcode !== 0) throw new DingTalkProviderError("not-member");
    const parsed = memberResultSchema.safeParse(response.result);
    if (!parsed.success) throw new DingTalkProviderError("unavailable");
    const member = parsed.data;
    if (member.userid !== userId) throw new DingTalkProviderError("tenant-mismatch");
    if (expectedUnionId && member.unionid !== expectedUnionId) {
      throw new DingTalkProviderError("tenant-mismatch");
    }
    if (!member.active) throw new DingTalkProviderError("inactive-member");
    const email = member.email?.trim() || null;
    return Object.freeze({
      corpId: this.#config.corpId,
      subjectId: member.userid,
      displayName: member.name,
      email,
      active: true,
    });
  }

  #classicPost(
    endpoint: string,
    appToken: string,
    body: Record<string, unknown>,
  ) {
    const url = new URL(endpoint);
    url.searchParams.set("access_token", appToken);
    return this.#requestJson(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((payload) => classicResponseSchema.parse(payload));
  }

  async #requestJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal });
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) > this.#maxResponseBytes) {
        throw new DingTalkProviderError("unavailable");
      }
      const text = await readBoundedText(response, this.#maxResponseBytes);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new DingTalkProviderError("unavailable");
      }
      if (!response.ok && (payload === null || typeof payload !== "object")) {
        throw new DingTalkProviderError("unavailable");
      }
      return payload;
    } catch (error) {
      throw stableProviderError(error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeCode(code: string): string {
  if (typeof code !== "string") throw new DingTalkProviderError("invalid-code");
  const normalized = code.trim();
  if (normalized.length < 1 || normalized.length > 2_000) {
    throw new DingTalkProviderError("invalid-code");
  }
  return normalized;
}

function stableProviderError(error: unknown): DingTalkProviderError {
  return error instanceof DingTalkProviderError
    ? error
    : new DingTalkProviderError("unavailable");
}

async function readBoundedText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DingTalkProviderError("unavailable");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
