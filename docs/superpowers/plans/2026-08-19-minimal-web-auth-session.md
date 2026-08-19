# Minimal Web Authentication Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the smallest browser login/session loop that prevents protected local-data work before authentication and returns expired sessions to login without replaying mutations.

**Architecture:** A focused `AuthSessionGate` owns session bootstrap, login, logout, and the authenticated user. The existing Amazon application remains intact behind that gate, while `localAgentFetch` remains the only same-origin browser transport and emits a bounded unauthorized notification for session recovery.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9, React 19, vinext, Zod 4 shared contracts, Node test runner through `tsx`, existing production stack launcher.

## Global Constraints

- Implement only the approved minimal Web authentication session design; do not add registration, invitation, reset/email, member management, connector administration, or UI redesign.
- Do not change Agent Service authorization, route policy, password/session persistence, proxy-token trust, or the anonymous fixture allowlist.
- The first browser Agent request is same-origin `GET /api/agent/v1/auth/session`; the main application must not mount before a validated authenticated response.
- Login uses the existing POST route, then confirms the HttpOnly cookie with a fresh session GET; password and session material never enter Web Storage, URLs, logs, model input, or client persistence.
- Any business-request `401` returns the mounted app to login and stops its effects; never automatically replay the failed request.
- Login `401` remains the generic invalid-credentials message. Login `429` remains generic and honors a valid `Retry-After` value.
- `admin` and `member` role labels come only from the validated session response and do not replace backend authorization.
- Keep `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK` unset or `0` for the authenticated tracer. Plain HTTP local login may use `AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE=1` only with non-production, all-loopback hosts/origins.
- Add no dependency and do not modify `package-lock.json`, migrations, generated artifacts, `.env.local`, existing `.superpowers/` WIP, or OpenSpec completion checkboxes.
- Use small new files; do not move the existing application body out of `app/page.tsx` or refactor its data flows.
- Each task produces one normal new commit. Do not amend, rebase, push, reset, stash, or clean.
- The current `stack:dev`/workerd loopback path is not the acceptance environment. Manual acceptance uses a fresh `npm run build` followed by `npm run stack:start`.

---

## Exact File Map

**Create:**

- `app/lib/web-auth-session.ts` — typed browser auth requests, validated state, and safe error classification.
- `app/auth-session-gate.tsx` — bootstrap/login/logout UI and authenticated render boundary.
- `tests/agent/web-auth-session.test.ts` — auth client/state and pre-auth mount tests.

**Modify:**

- `app/page.tsx` — rename the existing component internally, wrap it with the gate, and place the identity control in the existing top actions.
- `app/lib/local-agent-browser.ts` — force same-origin credentials and notify one bounded `401` subscriber set.
- `app/globals.css` — minimal login shell and identity-control styles only.
- `tests/agent/local-agent-browser.test.ts` — credentials and unauthorized notification tests.
- `tests/rendered-html.test.mjs` — assert the server-rendered auth bootstrap omits the protected application shell.
- `docs/runbooks/agent-stack.md` — append the authenticated production-build local tracer.

## Stable Interfaces

```ts
export type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type AuthSessionState =
  | Readonly<{ status: "checking"; user: null; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "unauthenticated"; user: null; message: string | null; retryAfterSeconds: number | null }>
  | Readonly<{ status: "submitting"; user: null; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "authenticated"; user: User; message: null; retryAfterSeconds: null }>
  | Readonly<{ status: "unavailable"; user: null; message: string; retryAfterSeconds: null }>;

export type WebAuthErrorKind = "invalid-credentials" | "rate-limited" | "unavailable";

export class WebAuthError extends Error {
  constructor(
    readonly kind: WebAuthErrorKind,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(kind);
  }
}

export async function readWebSession(fetchImpl?: AuthFetch): Promise<User | null>;
export async function loginAndReadWebSession(input: LoginRequest, fetchImpl?: AuthFetch): Promise<User>;
export async function logoutWebSession(fetchImpl?: AuthFetch): Promise<void>;
export function expireAuthenticatedSession(state: AuthSessionState): AuthSessionState;

export type AuthenticatedWebSession = Readonly<{
  user: User;
  logout: () => Promise<void>;
  logoutPending: boolean;
  logoutError: string | null;
}>;

export function subscribeToAuthenticationRequired(listener: () => void): () => void;
```

---

### Task 1: Typed Browser Authentication Client

**Files:**
- Create: `app/lib/web-auth-session.ts`
- Create: `tests/agent/web-auth-session.test.ts`

**Interfaces:**
- Consumes: existing `LoginRequestSchema`, `LoginResponseSchema`, `LogoutResponseSchema`, `SessionResponseSchema`, `User`, and `localAgentFetch`.
- Produces: all `Stable Interfaces` auth types/functions except `AuthenticatedWebSession` and the unauthorized subscription.

- [ ] **Step 1: Write client RED tests.** Use a sequence fetch double and assert: session false returns null; session true returns the exact validated user; inconsistent or malformed session responses become `WebAuthError("unavailable")`; login `401` becomes `invalid-credentials`; login `429` parses only canonical non-negative integer `Retry-After`; successful login always performs POST then GET; logout validates `{ok:true}`; expiry changes only an authenticated state.

```ts
const calls: Array<{ path: string; method: string }> = [];
const fetchImpl: AuthFetch = async (path, init) => {
  calls.push({ path, method: init?.method ?? "GET" });
  if (calls.length === 1) {
    return Response.json({ user }, { headers: { "set-cookie": "agent_session=opaque; HttpOnly; Path=/" } });
  }
  return Response.json({ authenticated: true, user });
};
assert.deepEqual(
  await loginAndReadWebSession({ email: "admin@example.com", password: "secret" }, fetchImpl),
  user,
);
assert.deepEqual(calls, [
  { path: "/v1/auth/login", method: "POST" },
  { path: "/v1/auth/session", method: "GET" },
]);
```

- [ ] **Step 2: Verify RED.** Run `npx tsx --conditions=react-server --test tests/agent/web-auth-session.test.ts`. Expected: FAIL because `app/lib/web-auth-session.ts` does not exist.

- [ ] **Step 3: Implement the minimal typed client.** Parse outbound credentials with `LoginRequestSchema`; parse successful bodies with the existing response schemas. Require `authenticated === (user !== null)`. Map only login status `401` and `429` to public login kinds; map network, non-OK, malformed JSON, invalid schema, and contradictory session shapes to `unavailable`. Do not read `Set-Cookie` or construct a client token.

```ts
export async function loginAndReadWebSession(
  input: LoginRequest,
  fetchImpl: AuthFetch = localAgentFetch,
): Promise<User> {
  const credentials = LoginRequestSchema.parse(input);
  const response = await fetchImpl("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
  if (response.status === 401) throw new WebAuthError("invalid-credentials");
  if (response.status === 429) {
    throw new WebAuthError("rate-limited", parseRetryAfter(response.headers.get("retry-after")));
  }
  if (!response.ok) throw new WebAuthError("unavailable");
  LoginResponseSchema.parse(await response.json());
  const user = await readWebSession(fetchImpl);
  if (!user) throw new WebAuthError("unavailable");
  return user;
}

export function expireAuthenticatedSession(state: AuthSessionState): AuthSessionState {
  return state.status === "authenticated"
    ? { status: "unauthenticated", user: null, message: "登录已失效，请重新登录", retryAfterSeconds: null }
    : state;
}
```

- [ ] **Step 4: Verify GREEN.** Re-run Step 2. Expected: all tests PASS and the sequence remains exactly two requests for login.

- [ ] **Step 5: Commit Task 1.**

```powershell
git add -- app/lib/web-auth-session.ts tests/agent/web-auth-session.test.ts
git diff --cached --check
git commit -m "feat(auth): add typed browser session client"
```

---

### Task 2: Authentication Gate, Login, Logout, and Role Display

**Files:**
- Create: `app/auth-session-gate.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/agent/web-auth-session.test.ts`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: Task 1 client/state functions.
- Produces: `AuthSessionGate`, `AuthIdentityControl`, and `AuthenticatedWebSession`.

- [ ] **Step 1: Write gate RED tests.** Server-render `AuthSessionGate` with a child function that increments a counter. Assert the initial checking markup is present, the counter is zero, and protected navigation text is absent. Render the focused login panel with an unauthenticated state and assert the existing product/Amazon mark, exact title “登录您的账户”, email input, password input, accessible show/hide-password button, blue submit button, and status region. Assert the markup contains none of `Google`, `GitHub`, `注册`, or `忘记密码`. Update rendered HTML expectations from the old immediately rendered brand shell to the authentication checking shell.

```ts
let childRenderCount = 0;
const html = renderToStaticMarkup(createElement(AuthSessionGate, {
  children: () => {
    childRenderCount += 1;
    return createElement("div", null, "protected-app");
  },
}));
assert.equal(childRenderCount, 0);
assert.match(html, /正在检查登录状态/);
assert.doesNotMatch(html, /protected-app/);
```

- [ ] **Step 2: Verify RED.** Run `npx tsx --conditions=react-server --test tests/agent/web-auth-session.test.ts`. Expected: FAIL because `AuthSessionGate` is missing.

- [ ] **Step 3: Implement `AuthSessionGate`.** On mount call `readWebSession()` once. Render only a neutral checking view until it resolves. Render only email/password fields in unauthenticated state. On submit set `submitting`, call `loginAndReadWebSession()`, clear the password in `finally`, and mount children only from the returned confirmed session user. Decrement a valid rate-limit wait with one bounded one-second timer. On bootstrap service errors render a retry button rather than assuming authentication state.

```tsx
export function AuthSessionGate({ children }: {
  children: (session: AuthenticatedWebSession) => ReactNode;
}) {
  const [state, setState] = useState<AuthSessionState>(CHECKING_AUTH_SESSION);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const bootstrap = useCallback(async () => {
    setState(CHECKING_AUTH_SESSION);
    try {
      const user = await readWebSession();
      setState(user
        ? { status: "authenticated", user, message: null, retryAfterSeconds: null }
        : { status: "unauthenticated", user: null, message: null, retryAfterSeconds: null });
    } catch {
      setState({ status: "unavailable", user: null, message: "登录服务暂时不可用，请重试", retryAfterSeconds: null });
    }
  }, []);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState({ status: "submitting", user: null, message: null, retryAfterSeconds: null });
    try {
      const user = await loginAndReadWebSession({ email, password });
      setState({ status: "authenticated", user, message: null, retryAfterSeconds: null });
    } catch (error) {
      setState(toSafeUnauthenticatedState(error));
    } finally {
      setPassword("");
    }
  }

  if (state.status === "authenticated") {
    return children({ user: state.user, logout, logoutPending, logoutError });
  }
  return renderCheckingUnavailableOrLogin(state, { email, password, setEmail, setPassword, submit, bootstrap });
}
```

`toSafeUnauthenticatedState()` returns only “邮箱或密码不正确”, “尝试次数过多，请稍后再试”, or the generic unavailable message. The component must not call Web Storage APIs. The password field starts as `type="password"`; the adjacent icon button has an exact accessible name of “显示密码” or “隐藏密码” and changes only the local visibility state.

- [ ] **Step 4: Place the existing app behind the gate.** Rename current `Home` to `AuthenticatedAmazonOpportunityApp`, add an `authSession` prop, and add `AuthIdentityControl` inside the existing `.top-actions`. Add a small new default export; do not move the existing component body.

```tsx
function AuthenticatedAmazonOpportunityApp({ authSession }: { authSession: AuthenticatedWebSession }) {
  // Existing Home hooks and application body remain here unchanged.
  // Existing top-actions begins with:
  // <AuthIdentityControl session={authSession} />
}

export default function Home() {
  return (
    <AuthSessionGate>
      {(session) => <AuthenticatedAmazonOpportunityApp authSession={session} />}
    </AuthSessionGate>
  );
}
```

`AuthIdentityControl` displays `displayName || email`, the exact `admin`/`member` role, logout progress, and a safe logout error. Failed logout keeps the app mounted and offers another logout attempt; successful logout enters unauthenticated state.

- [ ] **Step 5: Add only the approved Option A CSS.** Scope selectors under `.auth-session-shell`, `.auth-login-card`, `.auth-login-status`, and `.auth-identity-control`. Use a full-viewport light-blue/white radial or linear glow, a centered white card with `width: min(360px, calc(100vw - 32px))`, restrained rounding and shadow, and one blue full-width login button. Preserve existing layout/theme selectors and add no new visual system.

```css
.auth-session-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 16px;
  background:
    radial-gradient(circle at 50% 18%, rgba(164, 208, 255, .38), transparent 38%),
    linear-gradient(180deg, #f3f8ff 0%, #ffffff 100%);
}
.auth-login-card {
  width: min(360px, calc(100vw - 32px));
  padding: 28px;
  border: 1px solid #dce8f5;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 18px 48px rgba(48, 91, 138, .14);
}
.auth-login-submit {
  width: 100%;
  background: #2f80ed;
  color: #fff;
}
.auth-login-status {
  min-height: 20px;
  margin-top: 10px;
  text-align: center;
}
```

The card renders no provider separator, social button, registration link, or forgot-password link. At narrow widths the fixed `16px` shell padding remains visible on both sides.

- [ ] **Step 6: Verify Task 2 GREEN.** Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/web-auth-session.test.ts
npm run build
node --test tests/rendered-html.test.mjs
```

Expected: focused tests PASS; build exits 0; rendered HTML contains checking markup and no protected app/navigation markup. The focused login panel test proves the exact Option A controls and absence of alternate-login, registration, and forgot-password content.

- [ ] **Step 7: Commit Task 2.**

```powershell
git add -- app/auth-session-gate.tsx app/page.tsx app/globals.css tests/agent/web-auth-session.test.ts tests/rendered-html.test.mjs
git diff --cached --check
git commit -m "feat(auth): gate the web application behind login"
```

---

### Task 3: Same-Origin Cookie Transport and 401 Recovery

**Files:**
- Modify: `app/lib/local-agent-browser.ts`
- Modify: `app/auth-session-gate.tsx`
- Modify: `tests/agent/local-agent-browser.test.ts`
- Modify: `tests/agent/web-auth-session.test.ts`
- Verify: `tests/agent/proxy.test.ts`, `tests/agent/auth-routes.test.ts`, `tests/agent/local-data-bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 `expireAuthenticatedSession()` and Task 2 gate.
- Produces: `subscribeToAuthenticationRequired()` and explicit same-origin credential behavior.

- [ ] **Step 1: Write transport/recovery RED tests.** Stub global fetch, call `localAgentFetch`, and assert `credentials === "same-origin"`. Subscribe two listeners, return `401`, assert one notification each, unsubscribe one, and prove later `401` notifies only the remaining listener. Assert the wrapper returns the original response and never retries. Render the gate in checking state with a child that would call `/v1/local-data/projects`; assert child and fetch counts both remain zero.

```ts
let unauthorizedCount = 0;
const unsubscribe = subscribeToAuthenticationRequired(() => { unauthorizedCount += 1; });
const response = await localAgentFetch("/v1/local-data/projects");
assert.equal(response.status, 401);
assert.equal(unauthorizedCount, 1);
assert.equal(observedInit?.credentials, "same-origin");
assert.equal(fetchCallCount, 1);
unsubscribe();
```

- [ ] **Step 2: Verify RED.** Run `npx tsx --conditions=react-server --test tests/agent/local-agent-browser.test.ts tests/agent/web-auth-session.test.ts`. Expected: FAIL because credentials and subscription are absent.

- [ ] **Step 3: Implement the bounded notification.** Keep the current relative-path validation and headers. Force same-origin credentials after spreading caller input, await exactly one fetch, notify a snapshot of the listener set on `401`, and return the same response.

```ts
const authenticationRequiredListeners = new Set<() => void>();

export function subscribeToAuthenticationRequired(listener: () => void) {
  authenticationRequiredListeners.add(listener);
  return () => authenticationRequiredListeners.delete(listener);
}

export async function localAgentFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(localAgentProxyPath(path), {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (response.status === 401) {
    for (const listener of [...authenticationRequiredListeners]) listener();
  }
  return response;
}
```

- [ ] **Step 4: Connect gate recovery.** Subscribe once in `AuthSessionGate`; update through `expireAuthenticatedSession(current)`. That helper preserves checking, login submission, rate-limit, and unavailable states, so an invalid login `401` keeps its generic credential message. Cleanup the subscription on unmount. Do not retry or retain any failed request body.

```ts
useEffect(() => subscribeToAuthenticationRequired(() => {
  setState((current) => expireAuthenticatedSession(current));
}), []);
```

- [ ] **Step 5: Verify focused GREEN and existing security contracts.** Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/local-agent-browser.test.ts tests/agent/web-auth-session.test.ts
npx tsx --conditions=react-server --test tests/agent/proxy.test.ts tests/agent/auth-routes.test.ts tests/agent/local-data-bridge.test.ts
npx eslint app/auth-session-gate.tsx app/page.tsx app/lib/web-auth-session.ts app/lib/local-agent-browser.ts tests/agent/web-auth-session.test.ts tests/agent/local-agent-browser.test.ts
```

Expected: all selected tests PASS; ESLint exits 0; proxy Cookie/Set-Cookie/Retry-After tests and anonymous local-data denial remain unchanged and green.

- [ ] **Step 6: Commit Task 3.**

```powershell
git add -- app/lib/local-agent-browser.ts app/auth-session-gate.tsx tests/agent/local-agent-browser.test.ts tests/agent/web-auth-session.test.ts
git diff --cached --check
git commit -m "fix(auth): recover web sessions on unauthorized responses"
```

---

### Task 4: Fresh-Build Authenticated Local Tracer

**Files:**
- Modify: `docs/runbooks/agent-stack.md`
- Verify only: existing `.env.local`, database, Web, Agent Service, browser network panel

**Interfaces:**
- Consumes: Tasks 1–3 and existing `admin:init`, `build`, and `stack:start` scripts.
- Produces: one repeatable authenticated local acceptance procedure; no new runtime interface.

- [ ] **Step 1: Add the exact authenticated tracer to the runbook.** Document the commands below and state that `stack:dev` is excluded because of the current workerd loopback problem. Do not include actual passwords, proxy tokens, provider keys, or database credentials.

```powershell
# Run at the worktree root. Use the same SQLite path as the stack.
$env:NODE_ENV = "development"
$env:AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK = "0"
$env:AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE = "1"
$env:AGENT_SQLITE_PATH = (Join-Path $PWD "data\agent-service.sqlite")

# First deployment only; password is entered at the hidden prompt.
npm run admin:init -- --email admin@example.com --display-name Admin --organization-id 10000000-0000-4000-8000-000000000001

# Always rebuild before this acceptance run.
npm run build
npm run stack:start
```

If the first admin already exists, skip initialization and use that account. `stack:start` loads the existing uncommitted environment files; never echo them or stage them.

- [ ] **Step 2: Run the pre-browser focused gate.** Run the three commands from Task 3 Step 5 and `git diff --check`. Expected: all focused tests and lint PASS; diff check prints no error.

- [ ] **Step 3: Run the production-build local browser tracer.** Open the Web URL reported by `stack:start`. Before login, verify the only Agent call is `/api/agent/v1/auth/session` and no `/api/agent/v1/local-data/*` call occurs. Log in, verify role and logout are visible, enter three valid ASINs, and click “开始全自动分析”.

Expected evidence:

- login POST returns success, its immediate session GET returns `authenticated:true`, and no password/token is visible in storage or URL;
- subsequent local-data requests no longer return `401` and the real sync advances to its next named stage;
- if a connector/provider is unconfigured, the UI reports that precise later-stage configuration failure rather than authentication failure;
- logout returns to login and stops project/sync polling;
- one expired/revoked-session `401` returns to login and the failed mutation appears exactly once in the network log.

- [ ] **Step 4: Commit the runbook after successful tracer evidence.**

```powershell
git add -- docs/runbooks/agent-stack.md
git diff --cached --check
git commit -m "docs(auth): add authenticated web tracer"
git status --short
```

Expected final status: only pre-existing protected WIP such as `.superpowers/` remains untracked/modified; no `.env.local`, lockfile, migration, generated artifact, or unrelated file is staged.

---

## Plan Self-Review

- [x] **Spec coverage:** Tasks 1–4 cover first session GET, gated mounting, approved Option A login card and responsive spacing, login confirmation, HttpOnly-cookie-only state, safe `401`/`429`, role/logout UI, same-origin transport, expiry recovery without replay, zero pre-auth local-data calls, closed anonymous mode, admin initialization, and one fresh-build local tracer.
- [x] **Scope:** Registration, admin console, connector UI, permission changes, migration work, new dependencies, visual redesign, and broad regression campaigns are excluded.
- [x] **Placeholder scan:** Every changed file, interface, RED/GREEN command, expected result, and commit boundary is explicit.
- [x] **Type consistency:** `AuthSessionState`, `WebAuthError`, `AuthFetch`, `AuthenticatedWebSession`, and the unauthorized subscription have one spelling and one owner throughout all tasks.
- [x] **Runtime consistency:** Manual authenticated HTTP uses the independent insecure-loopback cookie flag with anonymous mode off and a production build started through `stack:start`; no acceptance relies on the known `stack:dev` path.
