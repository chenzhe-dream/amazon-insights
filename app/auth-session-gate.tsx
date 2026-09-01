"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import type { User } from "../shared/agent-contracts";
import { createBrowserActivityHeartbeatController } from "./lib/activity-heartbeat";
import { AuthSessionController } from "./lib/auth-session-controller";
import { subscribeToAuthenticationRequired } from "./lib/local-agent-browser";
import { changeWebPassword, expireAuthenticatedSession, type AuthSessionState, loginAndReadWebSession, logoutWebSession, readWebSession } from "./lib/web-auth-session";

export type AuthenticatedWebSession = Readonly<{
  user: User;
  sessionIdentity: string;
  logout: () => Promise<void>;
  logoutPending: boolean;
  logoutError: string | null;
}>;

function PasswordChangeControl() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dialogGeneration = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentPasswordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setMounted(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const openDialog = useCallback(() => {
    dialogGeneration.current += 1;
    setPending(false);
    setMessage(null);
    setOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    dialogGeneration.current += 1;
    setPending(false);
    setMessage(null);
    setOpen(false);
    if (triggerRef.current?.isConnected) triggerRef.current.focus();
  }, []);

  useEffect(() => {
    if (open && mounted) currentPasswordRef.current?.focus();
  }, [mounted, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDialog, open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const generation = dialogGeneration.current;
    setPending(true);
    setMessage(null);
    try {
      await changeWebPassword({
        currentPassword: String(data.get("currentPassword") ?? ""),
        newPassword: String(data.get("newPassword") ?? ""),
        confirmation: String(data.get("confirmation") ?? ""),
      });
      if (generation !== dialogGeneration.current) return;
      form.reset();
      setMessage("密码已更新，其他登录会话已退出");
    } catch {
      if (generation !== dialogGeneration.current) return;
      setMessage("密码更新失败，请检查当前密码和新密码");
    } finally {
      if (generation === dialogGeneration.current) setPending(false);
    }
  }

  const dialog = (
    <div className="auth-modal-backdrop" role="presentation">
      <form
        className="auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-change-title"
        onSubmit={(event) => void submit(event)}
      >
        <div className="section-head"><h2 id="password-change-title">修改密码</h2><button type="button" className="ghost-btn" onClick={closeDialog}>关闭</button></div>
        <label>当前密码<input ref={currentPasswordRef} name="currentPassword" type="password" minLength={8} maxLength={1024} autoComplete="current-password" required /></label>
        <label>新密码<input name="newPassword" type="password" minLength={8} maxLength={1024} autoComplete="new-password" required /></label>
        <label>确认新密码<input name="confirmation" type="password" minLength={8} maxLength={1024} autoComplete="new-password" required /></label>
        <button className="auth-login-submit" type="submit" disabled={pending}>{pending ? "更新中…" : "更新密码"}</button>
        {message ? <p className="auth-login-status" role="status">{message}</p> : null}
      </form>
    </div>
  );

  return <>
    <button ref={triggerRef} type="button" className="ghost-btn" onClick={openDialog}>修改密码</button>
    {open && mounted && typeof document !== "undefined"
      ? createPortal(dialog, document.body)
      : null}
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

function AuthenticatedActivityHeartbeat({ sessionIdentity }: { sessionIdentity: string }) {
  useEffect(() => {
    const controller = createBrowserActivityHeartbeatController();
    controller.start();
    return () => controller.stop();
  }, [sessionIdentity]);
  return null;
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
      {user.role === "admin" ? <Link className="ghost-btn" href="/admin/users">用户状态</Link> : null}
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
  if (state.status === "authenticated") return <>
    <AuthenticatedActivityHeartbeat sessionIdentity={state.sessionIdentity} />
    {children({ user: state.user, sessionIdentity: state.sessionIdentity, logout, logoutPending, logoutError })}
  </>;
  return <AuthLoginCard state={state} email={email} password={password} onEmailChange={setEmail} onPasswordChange={setPassword} onSubmit={(event) => void submit(event)} />;
}
