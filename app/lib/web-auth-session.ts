import {
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  SessionResponseSchema,
  type LoginRequest,
  type User,
} from "../../shared/agent-contracts";
import { localAgentFetch } from "./local-agent-browser";

export type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type AuthSessionState =
  | Readonly<{ status: "checking"; user: null; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "unauthenticated"; user: null; message: string | null; retryAfterSeconds: number | null }>
  | Readonly<{ status: "submitting"; user: null; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "authenticated"; user: User; message: null; retryAfterSeconds: null }>
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

export async function readWebSession(fetchImpl: AuthFetch = localAgentFetch): Promise<User | null> {
  try {
    const response = await fetchImpl("/v1/auth/session");
    const parsed = SessionResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) throw unavailable();
    if (parsed.data.authenticated) {
      if (parsed.data.user === null) throw unavailable();
      return parsed.data.user;
    }
    if (parsed.data.user !== null) throw unavailable();
    return null;
  } catch (error) {
    if (error instanceof WebAuthError) throw error;
    throw unavailable();
  }
}

export async function loginAndReadWebSession(
  input: LoginRequest,
  fetchImpl: AuthFetch = localAgentFetch,
): Promise<User> {
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

    const user = await readWebSession(fetchImpl);
    if (user === null) throw unavailable();
    return user;
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

export function expireAuthenticatedSession(state: AuthSessionState): AuthSessionState {
  if (state.status !== "authenticated") return state;
  return {
    status: "unauthenticated",
    user: null,
    message: "登录已失效，请重新登录",
    retryAfterSeconds: null,
  };
}
