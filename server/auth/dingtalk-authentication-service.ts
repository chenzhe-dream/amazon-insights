import { createHash, randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import type { DingTalkAuthenticationConfig } from "../config";
import type {
  DingTalkAuthenticationRepository,
} from "../db/repository";
import type {
  DingTalkIdentityProvider,
  VerifiedDingTalkIdentity,
} from "./dingtalk-provider";
import { assertMatchingDingTalkOAuthState } from "./dingtalk-state-cookie";
import type {
  AuthenticatedSessionResult,
  AuthenticationService,
} from "./authentication-service";

const DINGTALK_AUTHORIZATION_URL = "https://login.dingtalk.com/oauth2/auth";
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const emailSchema = z.email().max(320);

export type DingTalkAuthenticationErrorCategory =
  | "disabled"
  | "invalid-state"
  | "disabled-user"
  | "tenant-mismatch"
  | "unavailable";

export class DingTalkAuthenticationError extends Error {
  constructor(readonly category: DingTalkAuthenticationErrorCategory) {
    super(
      category === "invalid-state"
        ? "DingTalk OAuth state is invalid"
        : `DingTalk authentication failed: ${category}`,
    );
    this.name = "DingTalkAuthenticationError";
  }
}

type SessionIssuer = Pick<AuthenticationService, "issueSessionForVerifiedUser">;

export class DingTalkAuthenticationService {
  readonly #config: DingTalkAuthenticationConfig;
  readonly #repository?: DingTalkAuthenticationRepository;
  readonly #provider?: DingTalkIdentityProvider;
  readonly #sessionIssuer: SessionIssuer;
  readonly #now: () => Date;
  readonly #createState: () => string;
  readonly #createId: () => string;

  constructor(options: {
    config: DingTalkAuthenticationConfig;
    repository?: DingTalkAuthenticationRepository;
    provider?: DingTalkIdentityProvider;
    sessionIssuer: SessionIssuer;
    now?: () => Date;
    createState?: () => string;
    createId?: () => string;
  }) {
    this.#config = options.config;
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#sessionIssuer = options.sessionIssuer;
    this.#now = options.now ?? (() => new Date());
    this.#createState = options.createState ?? (() => randomBytes(32).toString("base64url"));
    this.#createId = options.createId ?? randomUUID;
  }

  publicConfig() {
    if (!this.#config.enabled) return Object.freeze({ enabled: false as const });
    return Object.freeze({
      enabled: true as const,
      clientId: this.#config.clientId,
      corpId: this.#config.corpId,
      agentId: this.#config.agentId,
    });
  }

  async startOAuth(returnPath: string) {
    const runtime = this.#runtime();
    const safeReturnPath = normalizeReturnPath(returnPath);
    const rawState = this.#createState();
    if (!STATE_PATTERN.test(rawState)) {
      throw new DingTalkAuthenticationError("unavailable");
    }
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + runtime.config.oauthStateTtlMs);
    await runtime.repository.createOAuthLoginState({
      stateHash: digestOAuthState(rawState),
      returnPath: safeReturnPath,
      expiresAt: expiresAt.toISOString(),
      createdAt: createdAt.toISOString(),
    });

    const authorizationUrl = new URL(DINGTALK_AUTHORIZATION_URL);
    authorizationUrl.searchParams.set("client_id", runtime.config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", runtime.config.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "openid");
    authorizationUrl.searchParams.set("prompt", "consent");
    authorizationUrl.searchParams.set("state", rawState);
    return Object.freeze({
      authorizationUrl: authorizationUrl.toString(),
      rawState,
      expiresAt: expiresAt.toISOString(),
    });
  }

  async completeOAuth(input: {
    code: string;
    state: string;
    cookieState: string | null;
  }): Promise<AuthenticatedSessionResult & { returnPath: string }> {
    const runtime = this.#runtime();
    try {
      assertMatchingDingTalkOAuthState(input.state, input.cookieState);
    } catch {
      throw new DingTalkAuthenticationError("invalid-state");
    }
    const now = this.#now().toISOString();
    const stored = await runtime.repository.consumeOAuthLoginState({
      stateHash: digestOAuthState(input.state),
      asOf: now,
      consumedAt: now,
    });
    if (!stored) throw new DingTalkAuthenticationError("invalid-state");
    const identity = await runtime.provider.exchangeOAuthCode(input.code);
    return Object.freeze({
      ...(await this.#finishVerifiedIdentity(identity)),
      returnPath: stored.returnPath,
    });
  }

  async loginWorkbench(code: string): Promise<AuthenticatedSessionResult> {
    const runtime = this.#runtime();
    return this.#finishVerifiedIdentity(
      await runtime.provider.exchangeWorkbenchCode(code),
    );
  }

  async #finishVerifiedIdentity(
    identity: VerifiedDingTalkIdentity,
  ): Promise<AuthenticatedSessionResult> {
    const runtime = this.#runtime();
    if (identity.corpId !== runtime.config.corpId) {
      throw new DingTalkAuthenticationError("tenant-mismatch");
    }
    if (!identity.active) {
      throw new DingTalkAuthenticationError("disabled-user");
    }
    const createdAt = this.#now().toISOString();
    const fallbackEmail = fallbackIdentityEmail(identity.corpId, identity.subjectId);
    const candidate = emailSchema.safeParse(identity.email?.trim().toLowerCase());
    const result = await runtime.repository.findOrCreateDingTalkUser({
      id: this.#createId(),
      organizationId: runtime.config.localOrganizationId,
      corpId: identity.corpId,
      subjectId: identity.subjectId,
      candidateEmail: candidate.success ? candidate.data : fallbackEmail,
      fallbackEmail,
      displayName: identity.displayName,
      createdAt,
      auditEventId: this.#createId(),
    });
    if (result.user.status !== "active") {
      throw new DingTalkAuthenticationError("disabled-user");
    }
    return this.#sessionIssuer.issueSessionForVerifiedUser(result.user);
  }

  #runtime(): {
    config: Extract<DingTalkAuthenticationConfig, { enabled: true }>;
    repository: DingTalkAuthenticationRepository;
    provider: DingTalkIdentityProvider;
  } {
    if (!this.#config.enabled) throw new DingTalkAuthenticationError("disabled");
    if (!this.#repository || !this.#provider) {
      throw new DingTalkAuthenticationError("unavailable");
    }
    return {
      config: this.#config,
      repository: this.#repository,
      provider: this.#provider,
    };
  }
}

export function digestOAuthState(rawState: string): string {
  if (!STATE_PATTERN.test(rawState)) {
    throw new DingTalkAuthenticationError("invalid-state");
  }
  return createHash("sha256").update(rawState).digest("hex");
}

function fallbackIdentityEmail(corpId: string, subjectId: string): string {
  const digest = createHash("sha256")
    .update(corpId)
    .update("\0")
    .update(subjectId)
    .digest("hex")
    .slice(0, 32);
  return `dingtalk-${digest}@identity.invalid`;
}

function normalizeReturnPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_000 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n\0]/.test(value)
  ) {
    throw new TypeError("DingTalk OAuth return path is invalid");
  }
  return value;
}
