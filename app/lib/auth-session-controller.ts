import type { User } from "../../shared/agent-contracts";
import { WebAuthError, type AuthSessionState } from "./web-auth-session";

export type AuthSessionControllerDependencies = Readonly<{
  readSession: () => Promise<User | null>;
  login: (credentials: { email: string; password: string }) => Promise<User>;
  logout: () => Promise<void>;
}>;

const CHECKING: AuthSessionState = { status: "checking", user: null, message: null, retryAfterSeconds: null };
const UNAVAILABLE = "登录服务暂时不可用，请重试";

function unauthenticated(message: string | null = null, retryAfterSeconds: number | null = null): AuthSessionState {
  return { status: "unauthenticated", user: null, message, retryAfterSeconds };
}

function loginFailure(error: unknown): AuthSessionState {
  if (error instanceof WebAuthError) {
    if (error.kind === "invalid-credentials") return unauthenticated("邮箱或密码不正确");
    if (error.kind === "rate-limited") return unauthenticated("尝试次数过多，请稍后再试", error.retryAfterSeconds);
  }
  return unauthenticated(UNAVAILABLE);
}

export class AuthSessionController {
  state: AuthSessionState = CHECKING;
  email = "";
  password = "";
  logoutPending = false;
  logoutError: string | null = null;

  constructor(private readonly dependencies: AuthSessionControllerDependencies) {}

  setCredentials(email: string, password: string) {
    this.email = email;
    this.password = password;
  }

  beginBootstrap() {
    this.state = CHECKING;
  }

  async bootstrap(showChecking = false) {
    if (showChecking) this.beginBootstrap();
    try {
      const user = await this.dependencies.readSession();
      this.state = user ? { status: "authenticated", user, message: null, retryAfterSeconds: null } : unauthenticated();
    } catch {
      this.state = { status: "unavailable", user: null, message: UNAVAILABLE, retryAfterSeconds: null };
    }
  }

  async submit() {
    this.state = { status: "submitting", user: null, message: null, retryAfterSeconds: null };
    try {
      const user = await this.dependencies.login({ email: this.email, password: this.password });
      this.state = { status: "authenticated", user, message: null, retryAfterSeconds: null };
    } catch (error) {
      this.state = loginFailure(error);
    } finally {
      this.password = "";
    }
  }

  tickRateLimit() {
    if (this.state.status === "unauthenticated" && this.state.retryAfterSeconds !== null && this.state.retryAfterSeconds > 0) {
      this.state = { ...this.state, retryAfterSeconds: this.state.retryAfterSeconds - 1 };
    }
  }

  async logout() {
    this.logoutPending = true;
    this.logoutError = null;
    try {
      await this.dependencies.logout();
      this.state = unauthenticated();
    } catch {
      this.logoutError = UNAVAILABLE;
    } finally {
      this.logoutPending = false;
    }
  }
}
