import {
  ChangePasswordRequestSchema,
  ChangePasswordResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  SessionResponseSchema,
  type LoginRequest,
  type ChangePasswordRequest,
  type User,
} from "../../shared/agent-contracts";
import { localAgentFetch } from "./local-agent-browser";

export type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;
export type AuthenticatedWebIdentity = Readonly<{ user: User; sessionIdentity: string }>;

export type AuthSessionState =
  | Readonly<{ status: "checking"; user: null; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "unauthenticated"; user: null; message: string | null; retryAfterSeconds: number | null }>
  | Readonly<{ status: "submitting"; user: null; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "authenticated"; user: User; sessionIdentity: string; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "unavailable"; user: null; message: string; retryAfterSeconds: null }>;

export type WebAuthErrorKind = "invalid-credentials" | "rate-limited" | "unavailable";

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
      return { user: parsed.data.user, sessionIdentity: parsed.data.sessionIdentity };
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
