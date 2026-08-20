"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "../shared/agent-contracts";
import { AuthSessionController } from "./lib/auth-session-controller";
import { subscribeToAuthenticationRequired } from "./lib/local-agent-browser";
import { expireAuthenticatedSession, type AuthSessionState, loginAndReadWebSession, logoutWebSession, readWebSession } from "./lib/web-auth-session";

export type AuthenticatedWebSession = Readonly<{
  user: User;
  logout: () => Promise<void>;
  logoutPending: boolean;
  logoutError: string | null;
}>;

function PasswordChangeControl() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/agent/v1/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: data.get("currentPassword"),
          newPassword: data.get("newPassword"),
          confirmation: data.get("confirmation"),
        }),
      });
      if (!response.ok) throw new Error();
      form.reset();
      setMessage("密码已更新，其他登录会话已退出");
    } catch {
      setMessage("密码更新失败，请检查当前密码和新密码");
    } finally {
      setPending(false);
    }
  }

  return <>
    <button type="button" className="ghost-btn" onClick={() => setOpen(true)}>修改密码</button>
    {open ? <div className="auth-modal-backdrop" role="presentation">
      <form className="auth-modal" onSubmit={(event) => void submit(event)}>
        <div className="section-head"><h2>修改密码</h2><button type="button" className="ghost-btn" onClick={() => setOpen(false)}>关闭</button></div>
        <label>当前密码<input name="currentPassword" type="password" minLength={8} maxLength={1024} autoComplete="current-password" required /></label>
        <label>新密码<input name="newPassword" type="password" minLength={8} maxLength={1024} autoComplete="new-password" required /></label>
        <label>确认新密码<input name="confirmation" type="password" minLength={8} maxLength={1024} autoComplete="new-password" required /></label>
        <button className="auth-login-submit" type="submit" disabled={pending}>{pending ? "更新中…" : "更新密码"}</button>
        {message ? <p className="auth-login-status" role="status">{message}</p> : null}
      </form>
    </div> : null}
  </>;
}

const CHECKING_AUTH_SESSION: AuthSessionState = {
  status: "checking",
  user: null,
  message: null,
  retryAfterSeconds: null,
};

function CheckingShell() {
  return <main className="auth-session-shell" aria-live="polite"><p>正在检查登录状态</p></main>;
}

export function AuthLoginCard({
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
            <input name="password" type={showPassword ? "text" : "password"} minLength={8} maxLength={1024} autoComplete="current-password" value={password} onChange={(event) => onPasswordChange(event.target.value)} required />
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
      <PasswordChangeControl />
      <button type="button" className="ghost-btn" disabled={logoutPending} onClick={() => void logout()}>
        {logoutPending ? "退出中…" : "退出登录"}
      </button>
      {logoutError ? <span className="auth-identity-error" role="status">{logoutError}</span> : null}
    </div>
  );
}

export function AuthSessionGate({ children }: {
  children: (session: AuthenticatedWebSession) => ReactNode;
}) {
  const [controller] = useState(() => new AuthSessionController({ readSession: readWebSession, login: loginAndReadWebSession, logout: logoutWebSession }));
  const [state, setState] = useState<AuthSessionState>(CHECKING_AUTH_SESSION);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const bootstrap = useCallback(async (showChecking = false) => {
    if (showChecking) {
      controller.beginBootstrap();
      setState(controller.state);
    }
    await controller.bootstrap();
    setState(controller.state);
  }, [controller]);

  useEffect(() => {
    let mounted = true;
    async function readInitialSession() {
      await controller.bootstrap();
      if (mounted) setState(controller.state);
    }
    void readInitialSession();
    return () => { mounted = false; };
  }, [controller]);

  useEffect(() => subscribeToAuthenticationRequired(() => {
    setState((current) => expireAuthenticatedSession(current));
  }), []);

  useEffect(() => {
    if (state.status !== "unauthenticated" || state.retryAfterSeconds === null || state.retryAfterSeconds <= 0) return;
    const timer = window.setTimeout(() => {
      controller.tickRateLimit();
      setState(controller.state);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [controller, state]);

  const logout = useCallback(async () => {
    const pending = controller.logout();
    setLogoutPending(controller.logoutPending);
    setLogoutError(controller.logoutError);
    await pending;
    setState(controller.state);
    setLogoutPending(controller.logoutPending);
    setLogoutError(controller.logoutError);
  }, [controller]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    controller.setCredentials(email, password);
    const pending = controller.submit();
    setState(controller.state);
    await pending;
    setState(controller.state);
    setPassword(controller.password);
  };

  if (state.status === "checking") return <CheckingShell />;
  if (state.status === "unavailable") {
    return <main className="auth-session-shell"><section className="auth-login-card"><p className="auth-login-status" role="status">{state.message}</p><button className="auth-login-submit" type="button" onClick={() => void bootstrap(true)}>重试</button></section></main>;
  }
  if (state.status === "authenticated") return children({ user: state.user, logout, logoutPending, logoutError });
  return <AuthLoginCard state={state} email={email} password={password} onEmailChange={setEmail} onPasswordChange={setPassword} onSubmit={(event) => void submit(event)} />;
}
