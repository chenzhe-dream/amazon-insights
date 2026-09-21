import {
  ChangePasswordRequestSchema,
  ChangePasswordResponseSchema,
  ApiErrorResponseSchema,
  DingTalkPublicConfigResponseSchema,
  DingTalkWorkbenchLoginRequestSchema,
  DingTalkWorkbenchLoginResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  SessionResponseSchema,
  type LoginRequest,
  type ChangePasswordRequest,
  type DingTalkPublicConfigResponse,
  type User,
} from "../../shared/agent-contracts";
import { localAgentFetch } from "./local-agent-browser";
import type {ModuleKey} from '../../shared/module-visibility-contracts';

export type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;
export type AuthenticatedWebIdentity = Readonly<{
  visibleModules?: ModuleKey[];
  isSystemOwner?: boolean;
  canManageModuleVisibility?: boolean;
  user: User;
  sessionIdentity: string;
  canViewUserPresence: boolean;
}>;

export type AuthSessionState =
  | Readonly<{ status: "checking"; user: null; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "unauthenticated"; user: null; message: string | null; retryAfterSeconds: number | null }>
  | Readonly<{ status: "submitting"; user: null; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "authenticated"; user: User; sessionIdentity: string; canViewUserPresence: boolean; visibleModules?: ModuleKey[]; isSystemOwner?: boolean; canManageModuleVisibility?: boolean; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "unavailable"; user: null; message: string; retryAfterSeconds: null }>;

export type WebAuthErrorKind =
  | "invalid-credentials"
  | "rate-limited"
  | "dingtalk-invalid-code"
  | "dingtalk-not-member"
  | "dingtalk-disabled"
  | "unavailable";

export class WebAuthError extends Error {
  constructor(readonly kind: WebAuthErrorKind, readonly retryAfterSeconds: number | null = null) {
    super(kind);
  }
}

function unavailable(): WebAuthError {
  return new WebAuthError("unavailable");
}

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw unavailable();
  try {
    return await response.json();
  } catch {
    throw unavailable();
  }
}

export async function readWebSession(fetchImpl: AuthFetch = localAgentFetch): Promise<AuthenticatedWebIdentity | null> {
  try {
    const response = await fetchImpl("/v1/auth/session");
    const parsed = SessionResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) throw unavailable();
    if (parsed.data.authenticated) {
      return {
        user: parsed.data.user,
        sessionIdentity: parsed.data.sessionIdentity,
        canViewUserPresence: parsed.data.canViewUserPresence,
        ...(parsed.data.visibleModules!==undefined?{visibleModules:parsed.data.visibleModules}:{}),
        ...(parsed.data.isSystemOwner!==undefined?{isSystemOwner:parsed.data.isSystemOwner}:{}),
        ...(parsed.data.canManageModuleVisibility!==undefined?{canManageModuleVisibility:parsed.data.canManageModuleVisibility}:{}),
      };
    }
    return null;
  } catch (error) {
    if (error instanceof WebAuthError) throw error;
    throw unavailable();
  }
}

export async function loginAndReadWebSession(
  input: LoginRequest,
  fetchImpl: AuthFetch = localAgentFetch,
): Promise<AuthenticatedWebIdentity> {
  try {
    const parsedInput = LoginRequestSchema.safeParse(input);
    if (!parsedInput.success) throw unavailable();

    const response = await fetchImpl("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify(parsedInput.data),
    });
    if (response.status === 401) throw new WebAuthError("invalid-credentials");
    if (response.status === 429) throw new WebAuthError("rate-limited", retryAfterSeconds(response));
    const login = LoginResponseSchema.safeParse(await readJson(response));
    if (!login.success) throw unavailable();

    const identity = await readWebSession(fetchImpl);
    if (identity === null) throw unavailable();
    return identity;
  } catch (error) {
    if (error instanceof WebAuthError) throw error;
    throw unavailable();
  }
}

export async function readDingTalkPublicConfig(
  fetchImpl: typeof fetch = fetch,
): Promise<DingTalkPublicConfigResponse> {
  try {
    const response = await fetchImpl("/api/auth/dingtalk/config", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    const parsed = DingTalkPublicConfigResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) throw unavailable();
    return parsed.data;
  } catch (error) {
    if (error instanceof WebAuthError) throw error;
    throw unavailable();
  }
}

export async function loginWithDingTalkWorkbenchCode(
  code: string,
  fetchImpl: AuthFetch = localAgentFetch,
): Promise<AuthenticatedWebIdentity> {
  try {
    const parsedInput = DingTalkWorkbenchLoginRequestSchema.safeParse({ code });
    if (!parsedInput.success) throw unavailable();
    const response = await fetchImpl("/v1/auth/dingtalk/workbench", {
      method: "POST",
      body: JSON.stringify(parsedInput.data),
    });
    if (!response.ok) throw await dingTalkWebError(response);
    const login = DingTalkWorkbenchLoginResponseSchema.safeParse(await response.json());
    if (!login.success) throw unavailable();
    const identity = await readWebSession(fetchImpl);
    if (!identity) throw unavailable();
    return identity;
  } catch (error) {
    if (error instanceof WebAuthError) throw error;
    throw unavailable();
  }
}

export async function logoutWebSession(fetchImpl: AuthFetch = localAgentFetch): Promise<void> {
  try {
    const response = await fetchImpl("/v1/auth/logout", { method: "POST" });
    const parsed = LogoutResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) throw unavailable();
  } catch (error) {
    if (error instanceof WebAuthError) throw error;
    throw unavailable();
  }
}

export async function changeWebPassword(
  input: ChangePasswordRequest,
  fetchImpl: AuthFetch = localAgentFetch,
): Promise<void> {
  try {
    const parsedInput = ChangePasswordRequestSchema.safeParse(input);
    if (!parsedInput.success) throw unavailable();
    const response = await fetchImpl("/v1/auth/password", {
      method: "POST",
      body: JSON.stringify(parsedInput.data),
    });
    const parsed = ChangePasswordResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) throw unavailable();
  } catch (error) {
    if (error instanceof WebAuthError) throw error;
    throw unavailable();
  }
}

export function expireAuthenticatedSession(state: AuthSessionState): AuthSessionState {
  if (state.status !== "authenticated") return state;
  return {
    status: "unauthenticated",
    user: null,
    message: "登录已失效，请重新登录",
    retryAfterSeconds: null,
  };
}

async function dingTalkWebError(response: Response): Promise<WebAuthError> {
  try {
    const parsed = ApiErrorResponseSchema.safeParse(await response.json());
    if (!parsed.success) return unavailable();
    switch (parsed.data.error.code) {
      case "DINGTALK_INVALID_CODE":
        return new WebAuthError("dingtalk-invalid-code");
      case "DINGTALK_NOT_MEMBER":
        return new WebAuthError("dingtalk-not-member");
      case "DINGTALK_DISABLED":
        return new WebAuthError("dingtalk-disabled");
      default:
        return unavailable();
    }
  } catch {
    return unavailable();
  }
}
