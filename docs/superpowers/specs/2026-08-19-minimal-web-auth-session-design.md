# Minimal Web Authentication Session Design

**Date:** 2026-08-19

**Status:** Approved design; implementation not started

**Scope:** Close the existing browser login/session gap without changing backend authorization

## Goal

Make the existing Web application usable with the already implemented OpenSpec 4.3 authentication model. The browser must establish an authenticated server session before the Amazon opportunity application mounts, so protected `local-data` effects cannot run anonymously and fail with `401`.

The tracer bullet is:

`GET session -> login form when unauthenticated -> POST login -> GET session -> mount application -> local-data and analysis calls use the HttpOnly cookie -> logout or any 401 unmounts the application`

## Verified Current State and Root Cause

The backend already provides the required security boundary:

- `GET /v1/auth/session`, `POST /v1/auth/login`, and `POST /v1/auth/logout` exist and use the shared strict contracts.
- Login creates a revocable server-side session and returns it through `Set-Cookie`; logout revokes it and clears the cookie.
- The same-origin proxy forwards the browser `Cookie`, preserves sanitized `Set-Cookie` and `Retry-After`, and never exposes the internal proxy token.
- Protected business routes require an active `admin` or `member` session. Connector management remains admin-only.
- Anonymous loopback access is restricted to the existing fixture-oriented route allowlist. In particular, project and sync `local-data` routes are not anonymous.
- `npm run admin:init` already supplies the one-time first-admin initialization flow.

The missing piece is browser orchestration. `app/page.tsx` currently mounts the complete application immediately. Its initial effects list or restore projects and inspect ASIN sync readiness, while `app/asin-sync-funnel.tsx` can start and poll sync work. Those calls reach protected `local-data` routes before a session exists, producing the reported `401`.

## Decision

Introduce one top-level client-side authentication gate. The current application subtree must not be created or mounted until `GET /api/agent/v1/auth/session` returns `{ authenticated: true, user }`.

This is preferred over adding an authentication guard to each effect because it establishes one auditable invariant: **no main-application effect exists before authentication**. It also covers both `/` and `/p/[slug]`, because the slug route re-exports the same page entry point.

Two alternatives are rejected:

1. Scattered `if (!user)` checks in each project, sync, VOC, keyword, and report effect are easy to miss and allow future pre-authentication regressions.
2. A server middleware redirect would duplicate session knowledge outside the Agent Service and does not by itself recover from expiry during a mounted client session.

## UI and State Model

### Approved Login Visual: Option A

The unauthenticated and checking states use a full-viewport, soft light-blue-to-white glow background. A single white card, approximately `360px` wide, is centered in the viewport with a restrained corner radius and light shadow. On viewports narrower than the card plus outer spacing, the card uses the available width with `16px` left and right margins.

The card contains only, in order:

1. the existing project/Amazon product-research mark already used by this application;
2. the exact title “登录您的账户”;
3. an email field;
4. a password field with one accessible show/hide-password icon control;
5. one blue login button; and
6. a safe Chinese status line below the button for checking, submitting, invalid credentials, rate limiting, unavailable service, or expired session.

It does not display Google, GitHub, or any other login provider; it does not display registration or forgot-password links. This visual decision changes neither the session data flow nor any backend route, permission, or authentication rule.

The gate owns these states:

- `checking`: initial session bootstrap is in flight; render a neutral loading shell and do not render the application.
- `unauthenticated`: render only the minimal email/password login form.
- `submitting`: keep the login form visible, disable duplicate submission, and clear stale messages.
- `authenticated`: retain the validated shared `User` value and mount the main application.
- `unavailable`: session truth could not be established because of a network or service error; render a retry action, not an assumed login form.

On first browser render the only Agent request is same-origin `GET /api/agent/v1/auth/session`. A successful `{ authenticated: false, user: null }` enters `unauthenticated`; a validated active user enters `authenticated`.

The login form sends `POST /api/agent/v1/auth/login` with `{ email, password }`. It never stores the password, session token, or login response in `localStorage`, `sessionStorage`, URL parameters, logs, or application persistence. After the POST completes, the password field is cleared. Success is not trusted solely from the POST body: the gate immediately repeats `GET /api/agent/v1/auth/session` and mounts the application only from that confirmed cookie-backed result.

The authenticated top bar gains a compact identity control showing `displayName` or email, plus an explicit `admin` or `member` badge and a logout button. Logout sends `POST /api/agent/v1/auth/logout`, then returns to `unauthenticated` and unmounts the application after the response. It must not clear unrelated browser project preferences.

## Same-Origin Cookie and 401 Recovery

All browser authentication and business requests continue through `/api/agent/v1/...`; the browser never calls the Agent Service port directly. `localAgentFetch` should state `credentials: "same-origin"` explicitly while preserving caller options, headers, and existing same-origin path validation. The HttpOnly cookie remains unreadable to React code.

`localAgentFetch` becomes the single observation point for session expiry. It may expose a small subscribe/unsubscribe API and notify subscribers after any response with status `401`. The authentication gate subscribes while mounted; a notification clears its in-memory user, enters `unauthenticated`, and therefore unmounts the main application and all polling/effects.

The wrapper still returns the original `Response` to its caller. It must not automatically replay failed mutations after a later login, because replaying project writes or analysis submissions could duplicate work. After re-authentication, the user explicitly repeats the interrupted action.

The session bootstrap endpoint normally expresses an absent session as HTTP 200 with `authenticated: false`; a `401` from any other request is treated as an expired, revoked, disabled, or otherwise invalid session without trying to distinguish those cases in the UI.

## Safe Error Presentation

| Condition | Browser behavior | User-facing message boundary |
| --- | --- | --- |
| Login `401` | Remain unauthenticated | Generic “邮箱或密码不正确”; do not reveal whether an account exists or is disabled |
| Login `429` | Remain unauthenticated; temporarily disable resubmission according to a valid `Retry-After` when present | Generic “尝试次数过多，请稍后再试” |
| Login validation `400` | Remain unauthenticated | Ask the user to check input format; do not render raw validation internals |
| Session/bootstrap network or `5xx` | Enter `unavailable` with retry | Generic service-unavailable message, no secret or stack output |
| Any authenticated request `401` | Clear in-memory user and unmount the application | Generic “登录已失效，请重新登录” |
| Logout failure | Unmount only after the server response is known; offer retry if service is unavailable | Do not claim the session was revoked when revocation was not confirmed |

## Security and Authorization Boundaries

- This change adds UI session orchestration only. It does not weaken or bypass the Agent Service authorization middleware.
- `admin` and `member` are display and authorization inputs from the validated session response; the browser cannot elevate a role.
- Anonymous mode stays an explicit non-production loopback compatibility mode and remains limited to the existing fixture allowlist. It does not gain access to project or sync routes.
- The first admin continues to be created only with `npm run admin:init`; there is no public registration page or browser bootstrap-admin flow.
- A connector administration UI, member invitation, password reset, email delivery, and account management are deferred. Existing admin-only connector HTTP capabilities are unchanged.
- No credential, Cookie, password, session identifier, connector secret, or internal proxy token may enter local storage, logs, analytics, URL state, or model input.

## Intended File Boundary

Implementation should be limited to:

- `app/auth-session-gate.tsx` (new): state machine, minimal login/unavailable views, session confirmation, logout, and authenticated identity control.
- `app/page.tsx`: keep the existing application as an authenticated child and make the default export render it through the gate; do not rewrite the main UI or its data effects.
- `app/lib/local-agent-browser.ts`: explicit same-origin credentials and bounded `401` notification subscription.
- `app/globals.css` or the existing theme stylesheet: only minimal login/identity styles.
- `tests/agent/web-auth-session.test.ts` (new): deterministic gate/controller behavior using injected fetch or pure state transitions, without introducing a new UI framework.
- `tests/agent/local-agent-browser.test.ts`: cookie mode and centralized `401` notification behavior.
- `tests/agent/proxy.test.ts`: retain or strengthen request `Cookie`, response `Set-Cookie`, and `Retry-After` passthrough coverage.

No database migration, new dependency, connector change, backend permission change, package-lock update, or generated artifact is required.

## TDD Acceptance Cases

Implementation proceeds test-first and must cover:

1. **Session bootstrap:** the gate issues one session GET first; authenticated response mounts the main child with the validated user.
2. **No pre-auth local-data:** while checking or unauthenticated, the main child is not mounted and no `local-data`, project restore, sync readiness, sync start, VOC, keyword, traffic, or report request occurs.
3. **Login confirmation:** an unauthenticated session shows the minimal form; successful POST is followed by session GET, and only that confirmed response mounts the child.
4. **No browser secret storage:** login does not write password or token to Web Storage and clears password state after submission.
5. **Cookie passthrough:** browser fetch uses same-origin credentials; the proxy forwards `Cookie` and preserves sanitized `Set-Cookie` without exposing the proxy token.
6. **Logout:** logout posts through the proxy, revokes/clears the cookie through the existing backend, and unmounts the child.
7. **401 recovery:** a `401` from a nested `localAgentFetch` notifies the gate, clears the user, stops the mounted application/polling, and shows the expired-session login state without replaying the failed request.
8. **Safe login failures:** invalid credentials show the same generic `401` message for unknown and disabled users; `429` respects `Retry-After` without disclosing limiter internals.
9. **Unavailable bootstrap:** network and `5xx` bootstrap failures show retry and never optimistically mount either the application or login submission path.
10. **Role display:** authenticated admin and member responses render the correct badge; display state never changes backend permissions.

Focused gates should include the new auth-session test, `tests/agent/local-agent-browser.test.ts`, `tests/agent/proxy.test.ts`, `tests/agent/auth-routes.test.ts`, and `tests/agent/local-data-bridge.test.ts`, followed by the affected linter/build gate. Existing backend auth tests remain the source of truth for hashing, revocation, limiter, and authorization behavior rather than duplicating those internals in UI tests.

## Manual Local Acceptance

Use the same database for the Web proxy and Agent Service. For plain HTTP loopback development only, use `NODE_ENV=development` and explicitly set `AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE=1`; leave `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK` unset or `0`. The insecure-cookie flag is forbidden outside loopback development. HTTPS production keeps the default Secure `__Host-agent_session` cookie and does not set the insecure flag.

1. Initialize the first admin once with `npm run admin:init -- --email <admin-email> --display-name <name> --organization-id <uuid>` and enter the password only at the hidden prompt.
2. Start the existing Web and Agent Service processes with their shared SQLite path or `AGENT_DATABASE_URL` and existing proxy/origin configuration.
3. Open the Web URL. Confirm the approved centered Option A card appears with the existing product mark, exact title, email/password fields, password visibility control, blue login button, and no alternate-login, registration, or forgot-password action. Confirm browser network activity contains the session GET but no project or sync `local-data` call.
4. Log in. Confirm the role badge and logout control appear and project/sync requests now carry the server session cookie through the same-origin proxy.
5. Enter the three-ASIN fixture or configured real ASIN set and click “开始全自动分析”. Confirm `local-data` no longer returns `401` and the sync/analysis pipeline advances to the next stage. Any later connector or provider configuration error is reported as that stage's error, not as authentication failure.
6. Log out, then confirm the application unmounts, the login form returns, and no background polling continues.

## Completion Boundary

This design is complete when the above automated cases and one manual authenticated tracer bullet pass with anonymous mode disabled. It does not claim production deployment readiness, add a full administration console, alter connector credentials, or redesign the existing analysis UI. Those concerns remain separate changes after the local authenticated loop is proven.
