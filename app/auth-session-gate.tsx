"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "../shared/agent-contracts";
import {
  WebAuthError,
  type AuthSessionState,
  loginAndReadWebSession,
  logoutWebSession,
  readWebSession,
} from "./lib/web-auth-session";

export type AuthenticatedWebSession = Readonly<{
  user: User;
  logout: () => Promise<void>;
  logoutPending: boolean;
  logoutError: string | null;
}>;

const CHECKING_AUTH_SESSION: AuthSessionState = {
  status: "checking",
  user: null,
  message: null,
  retryAfterSeconds: null,
};

const LOGIN_UNAVAILABLE_MESSAGE = "登录服务暂时不可用，请重试";

function unauthenticated(message: string | null = null, retryAfterSeconds: number | null = null): AuthSessionState {
  return { status: "unauthenticated", user: null, message, retryAfterSeconds };
}

function safeLoginFailure(error: unknown): AuthSessionState {
  if (error instanceof WebAuthError) {
    if (error.kind === "invalid-credentials") return unauthenticated("邮箱或密码不正确");
    if (error.kind === "rate-limited") return unauthenticated("尝试次数过多，请稍后再试", error.retryAfterSeconds);
  }
  return unauthenticated(LOGIN_UNAVAILABLE_MESSAGE);
}

function CheckingShell() {
  return <main className="auth-session-shell" aria-live="polite"><p>正在检查登录状态</p></main>;
}

function AuthLoginCard({
  state,
  email,
  password,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: {
  state: Extract<AuthSessionState, { status: "unauthenticated" | "submitting" }>;
  email: string;
  password: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const waiting = state.retryAfterSeconds !== null && state.retryAfterSeconds > 0;
  const submitting = state.status === "submitting";

  return (
    <main className="auth-session-shell">
      <form className="auth-login-card" onSubmit={onSubmit}>
        <img className="auth-login-brand" src="/amazon-logo.svg" alt="Amazon" />
        <h1>登录您的账户</h1>
        <label>
          邮箱
          <input name="email" type="email" autoComplete="email" value={email} onChange={(event) => onEmailChange(event.target.value)} required />
        </label>
        <label>
          密码
          <span className="auth-password-field">
            <input name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => onPasswordChange(event.target.value)} required />
            <button type="button" className="auth-password-toggle" aria-label={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword((current) => !current)}>
              {showPassword ? "隐藏" : "显示"}
            </button>
          </span>
        </label>
        <button className="auth-login-submit" type="submit" disabled={submitting || waiting}>
          {submitting ? "登录中…" : "登录"}
        </button>
        <p className="auth-login-status" role="status">{state.message}{waiting ? `（${state.retryAfterSeconds} 秒后重试）` : ""}</p>
      </form>
    </main>
  );
}

export function AuthIdentityControl({ session }: { session: AuthenticatedWebSession }) {
  const { user, logout, logoutError, logoutPending } = session;
  return (
    <div className="auth-identity-control">
      <span className="auth-identity-name">{user.displayName || user.email}</span>
      <span className="auth-identity-role">{user.role}</span>
      <button type="button" className="ghost-btn" disabled={logoutPending} onClick={() => void logout()}>
        {logoutPending ? "退出中…" : "退出登录"}
      </button>
      {logoutError ? <span className="auth-identity-error" role="status">{logoutError}</span> : null}
    </div>
  );
}

export function AuthSessionGate({ children, initialState }: {
  children: (session: AuthenticatedWebSession) => ReactNode;
  initialState?: AuthSessionState;
}) {
  const [state, setState] = useState<AuthSessionState>(initialState ?? CHECKING_AUTH_SESSION);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const bootstrap = useCallback(async () => {
    setState(CHECKING_AUTH_SESSION);
    try {
      const user = await readWebSession();
      setState(user ? { status: "authenticated", user, message: null, retryAfterSeconds: null } : unauthenticated());
    } catch {
      setState({ status: "unavailable", user: null, message: LOGIN_UNAVAILABLE_MESSAGE, retryAfterSeconds: null });
    }
  }, []);

  useEffect(() => {
    if (initialState === undefined) void bootstrap();
  }, [bootstrap, initialState]);

  useEffect(() => {
    if (state.status !== "unauthenticated" || state.retryAfterSeconds === null || state.retryAfterSeconds <= 0) return;
    const timer = window.setTimeout(() => {
      setState((current) => current.status === "unauthenticated" && current.retryAfterSeconds !== null && current.retryAfterSeconds > 0
        ? { ...current, retryAfterSeconds: current.retryAfterSeconds - 1 }
        : current);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const logout = useCallback(async () => {
    setLogoutPending(true);
    setLogoutError(null);
    try {
      await logoutWebSession();
      setState(unauthenticated());
    } catch {
      setLogoutError(LOGIN_UNAVAILABLE_MESSAGE);
    } finally {
      setLogoutPending(false);
    }
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState({ status: "submitting", user: null, message: null, retryAfterSeconds: null });
    try {
      const user = await loginAndReadWebSession({ email, password });
      setState({ status: "authenticated", user, message: null, retryAfterSeconds: null });
    } catch (error) {
      setState(safeLoginFailure(error));
    } finally {
      setPassword("");
    }
  };

  if (state.status === "checking") return <CheckingShell />;
  if (state.status === "unavailable") {
    return <main className="auth-session-shell"><section className="auth-login-card"><p className="auth-login-status" role="status">{state.message}</p><button className="auth-login-submit" type="button" onClick={() => void bootstrap()}>重试</button></section></main>;
  }
  if (state.status === "authenticated") return children({ user: state.user, logout, logoutPending, logoutError });
  return <AuthLoginCard state={state} email={email} password={password} onEmailChange={setEmail} onPasswordChange={setPassword} onSubmit={(event) => void submit(event)} />;
}
