# Agent Authentication Design

## Goal

Define the OpenSpec 4.3 authentication and minimum authorization boundary for the vinext Web proxy and Node Agent Service. Every protected business request must prove both that it came through the trusted Web proxy and that it belongs to a valid organization user session. The implementation must preserve an explicit loopback-only fixture smoke escape hatch without weakening non-loopback or production deployments.

This design refines the existing `access-control` capability. It does not implement code, tests, migrations, UI, deployment, or PostgreSQL support.

## Scope

OpenSpec 4.3 will implement:

- one-time first-admin initialization through a local CLI;
- per-user salted scrypt password storage and verification;
- login, logout, current-session, and protected-request authentication;
- opaque, revocable server-side sessions carried by HttpOnly cookies;
- independent Agent Service proxy-token and user-session checks;
- bounded in-memory login limiting by normalized email and client IP;
- `admin` and `member` authorization, including the minimum admin-only connector/system status surface;
- explicit loopback-only compatibility flags for fixture smoke and insecure local cookies;
- sanitized errors, security events, and focused authentication/authorization tests.

OpenSpec 4.3 will not:

- redesign the login page or the wider application UI;
- add invitations, public registration, password reset email, SSO, MFA, or account recovery;
- add connector secret editing, secret rotation, or a general key-management UI;
- implement PostgreSQL, distributed sessions, or distributed rate limiting;
- change project sharing beyond the existing single-organization `admin`/`member` model;
- make the Web process a substitute for Agent Service authorization;
- weaken the existing `x-agent-proxy-token` boundary.

## Trust Boundaries

### Protected request flow

```text
Browser
  Cookie: __Host-agent_session=<opaque token>
      |
      v
vinext proxy
  - receives the HttpOnly cookie
  - overwrites trusted client-IP metadata from the browser socket
  - adds x-agent-proxy-token from server-only configuration
  - forwards cookie + proxy token to Agent Service
      |
      v
Agent Service
  1. verifies x-agent-proxy-token
  2. hashes and verifies the session cookie
  3. loads active user + organization + role
  4. applies route authorization
```

The two credentials prove different facts and are not interchangeable:

- `x-agent-proxy-token` proves that the request passed through an authorized vinext server instance. It does not identify a user.
- the session cookie proves that an active organization user authenticated and has a current role. It does not authorize a caller to bypass the vinext proxy.

Every protected Agent Service route requires both checks. A valid user cookie sent directly without the proxy token is rejected. A valid proxy token without a valid user session is also rejected, except for the explicitly defined login/bootstrap and loopback-fixture cases below.

The browser never receives `x-agent-proxy-token`. The vinext proxy must remove any browser-supplied value for that header and set its own configured value. It must likewise overwrite, not append to, the trusted client-IP header. Agent Service trusts forwarded client-IP metadata only after the proxy token succeeds.

### Auth endpoint exceptions

- `POST /v1/auth/login` requires the proxy token but cannot require an existing user session. It accepts only normalized email and password over the request body.
- `POST /v1/auth/logout` requires the proxy token and consumes the presented cookie if present. It revokes the matching session and clears the cookie; an already absent or revoked session returns an idempotent logged-out response.
- `GET /v1/auth/session` requires the proxy token. It returns a minimal authenticated user view for a valid session and a sanitized unauthenticated response otherwise.
- first-admin initialization is not an HTTP route. It is available only through the one-time local CLI.

All business, report, project, run, connector, and system routes remain protected.

## First-Admin Initialization

An operator invokes a local one-time CLI from the Agent Service deployment environment. The CLI accepts non-secret options such as database location, normalized email, and display name, but it must not accept a password through command-line arguments. Command lines are observable through shell history and process inspection.

Password entry uses a hidden interactive TTY prompt with confirmation. The CLI refuses non-interactive password input unless a future separately reviewed secret-input mechanism is specified. It never prints the password, salt, derived key, session token, or full user record.

Inside one database transaction, the CLI:

1. verifies that no user exists;
2. normalizes and validates the email;
3. generates a cryptographically random per-user salt;
4. derives a password hash with Node scrypt using versioned, explicitly bounded parameters;
5. creates the first active `admin` in the single organization;
6. appends a sanitized initialization audit event;
7. commits only if all steps succeed.

If any user already exists, the CLI fails closed and does not update, reset, or promote an account. Later user lifecycle workflows are outside 4.3.

## Password Storage and Verification

Each user password record is a versioned encoding containing the scrypt algorithm identifier, parameters, random salt, and derived key. Every user receives an independent salt from the operating-system cryptographic RNG. Passwords are never encrypted for recovery and are never stored or logged in raw form.

Verification parses only the closed supported encoding, enforces parameter ceilings before performing work, derives the candidate key, and compares fixed-length bytes in constant time. Unsupported, malformed, or excessive-cost encodings fail authentication without exposing parser details.

Login uses the same bounded scrypt operation for an unknown email, a user without a usable password, and a disabled user by verifying against a process-held dummy record. This prevents the fast failure path from becoming a practical account-enumeration signal. The external response and status are identical for unknown email, incorrect password, missing password, and disabled account.

## Session Model

### Token generation and persistence

A successful login creates a cryptographically random opaque token with at least 256 bits of entropy. The raw token exists only in memory long enough to build the `Set-Cookie` response and then in the browser cookie. It is never returned in JSON, written to the database, included in URLs, or logged.

Agent Service computes `SHA-256(rawToken)` and stores only that digest in the existing `sessions.token_hash` column, together with session ID, user ID, organization, creation time, expiry, revocation state, and allowed audit metadata. Session lookup hashes the presented raw cookie and queries by digest.

Session validation rejects when any of these conditions is true:

- the cookie is missing, duplicated, malformed, or outside the closed size/character bounds;
- the digest has no matching session;
- the session is expired or revoked;
- the referenced user is missing or disabled;
- the user organization is invalid or does not match the protected resource scope;
- repository access or strict row parsing fails.

No validation failure falls back to an older session or cached role. Disabling a user revokes that user's current sessions atomically; even if revocation is interrupted, the active-user check independently rejects future requests.

### Cookie profiles

Production and secure development use:

```text
Name: __Host-agent_session
Secure
HttpOnly
SameSite=Lax
Path=/
No Domain attribute
```

The `__Host-` prefix is used only when `Secure` is true. This prevents a domain-scoped or insecure cookie from masquerading as the production session.

Plain-HTTP local development requires the separate explicit flag:

```text
AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE=1
```

It is accepted only when the Agent Service bind address and every trusted Web origin are loopback. In that profile the cookie is named `agent_session`, remains `HttpOnly`, `SameSite=Lax`, `Path=/`, and has no `Domain`, but omits `Secure`. If the flag is absent, login over plain HTTP cannot issue an insecure substitute; the operator must use HTTPS or explicitly enable the loopback-only profile. If the flag is set with any non-loopback bind or trusted origin, startup fails closed and emits a sanitized configuration warning.

Cookie clearing uses the active profile's exact name, path, security, SameSite, and no-Domain attributes with an expired maximum age.

## Authentication Modes and Startup Validation

The default is authenticated mode everywhere, including local loopback. Production mode or any non-loopback bind/origin always requires user sessions.

Legacy fixture smoke can omit only the user-session layer when all of the following are true:

```text
AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=1
```

- the Agent Service bind address is loopback;
- every configured trusted Web origin is loopback;
- the request arrives through the valid proxy-token boundary;
- the runtime is not production;
- the route is within the existing fixture smoke surface and does not expose admin operations.

Loopback means an explicitly recognized local host/address such as `127.0.0.0/8`, `::1`, or a validated `localhost` origin. Wildcard binds including `0.0.0.0` and `::`, LAN addresses, public names, and mixed loopback/non-loopback origin lists are not loopback.

Without `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=1`, loopback requests require login. With the flag enabled, the proxy token remains mandatory and admin-only routes remain unavailable to anonymous smoke. The mode is resolved once during startup; it cannot be activated per request.

If the anonymous flag is set in production or with any non-loopback bind/trusted origin, Agent Service refuses to start and writes a sanitized high-severity configuration warning naming the unsafe flag and the closed reason, but not tokens, origins containing credentials, or other environment values. It must not silently ignore the unsafe configuration and continue in an uncertain mode.

`AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE` and `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK` are independent. One controls cookie transport for authenticated local users; the other permits a narrow anonymous fixture smoke path. Enabling either does not imply the other.

## Login Flow and Rate Limiting

The login handler performs these steps in order:

1. validate the proxy token and closed request shape;
2. normalize email and the trusted client IP;
3. consult bounded in-memory limiters for the normalized email and client IP;
4. load the user or select the dummy password record;
5. perform exactly one bounded scrypt verification;
6. record success or failure without raw credentials;
7. for an active valid user, create the server-side session and set the cookie;
8. otherwise return the same generic invalid-credentials response.

The implementation maintains separate bounded buckets for normalized email and client IP; exceeding either bucket rejects the attempt with `429 LOGIN_RATE_LIMITED`. This prevents rotating one dimension from trivially bypassing the other. The limiter has explicit maximum entries and expiry cleanup so untrusted inputs cannot cause unbounded memory growth.

Rate-limit state is process-local in 4.3 and resets on restart. This is acceptable only for the current single Agent Service instance. A multi-instance or hostile-internet deployment requires a later distributed limiter change; 4.3 does not claim cross-instance enforcement.

For requests forwarded by vinext, the proxy derives the browser client IP from its accepted socket/trusted hosting context, removes browser-supplied forwarding headers, and sets one closed internal client-IP header. Agent Service uses that header only after proxy-token validation. Missing or invalid metadata maps to one fixed unknown-source bucket rather than trusting arbitrary text.

Unknown email, disabled user, wrong password, malformed stored hash, and missing password all consume comparable verification work and produce the same generic response. Neither response time, body, status, headers, nor log wording intentionally reveals whether an email exists.

## Authorization

The authenticated principal is a closed object containing only user ID, organization ID, role (`admin` or `member`), and session ID. Route handlers receive this principal from middleware and must not reconstruct identity from request bodies, query parameters, or client headers.

`member` may use the existing team business surface: create and view shared projects, start and observe analyses, read reports, and export authorized results. `member` cannot read or mutate connector secrets, user roles, account status, authentication configuration, or system administration state.

`admin` includes member permissions. In 4.3, `GET /v1/capabilities` and `POST /v1/connectors/:connectorId/probe` are the minimum admin-only status surface; a member receives `403 FORBIDDEN` from both. Status responses remain sanitized and never return secret values. Secret editing, user invitation, role management UI, and credential rotation remain outside scope even though the wider access-control capability assigns them to future admin workflows.

Authorization order is authentication, organization scope, then role. A missing business resource and a cross-organization business resource both return the route's sanitized `404 NOT_FOUND`, so the caller cannot distinguish existence. A role failure on an existing same-organization admin route returns `403 FORBIDDEN` without disclosing secret configuration or hidden resource fields.

Anonymous loopback fixture smoke receives a dedicated restricted principal or equivalent explicit mode marker. It is never treated as `admin`, never receives a user ID, and cannot access admin-only status routes.

## Error and Log Safety

Authentication responses use closed public codes and fixed messages:

- `AUTHENTICATION_REQUIRED` for missing or invalid sessions on protected routes;
- `INVALID_CREDENTIALS` for all login credential failures;
- `LOGIN_RATE_LIMITED` for bounded login throttling;
- `FORBIDDEN` for authenticated role failures;
- existing proxy-authentication errors for an invalid `x-agent-proxy-token`.

Responses never include raw cookies, session digests, password material, salts, scrypt output, proxy tokens, database rows, stack traces, account existence, or disabled status.

Security logs may contain event type, request correlation ID, normalized route class, outcome code, session ID after successful lookup, actor user ID after authentication, and a one-way bounded email/IP correlation fingerprint. Logs must not contain raw password, raw email where unnecessary, cookie headers, `Set-Cookie`, raw session token, token hash, proxy token, CLI input, or full environment values.

All unexpected repository, parser, and crypto errors map to safe authentication failure or safe service-unavailable behavior. Raw causes remain internal and must pass the existing redaction boundary before structured logging.

## Configuration Contract

The authentication configuration is parsed once at startup from a strict allowlist. At minimum it resolves:

- secure cookie lifetime and session lifetime within fixed bounds;
- Agent Service bind address and trusted Web origins;
- production/development runtime classification;
- `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK`;
- `AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE`;
- fixed, versioned scrypt parameters within implementation ceilings;
- bounded login limiter window, threshold, and maximum entry count.

Boolean flags accept only the canonical enabled value `1` or absence/`0` according to the shared configuration convention. Blank, mixed-case, or alternative truthy strings fail validation instead of unexpectedly enabling an unsafe mode.

Configuration summaries expose only resolved booleans and safe mode names. They never echo proxy tokens, cookie values, password material, or credentialed origin URLs.

## Test Strategy

All authentication tests use temporary SQLite databases, fake clocks, deterministic injected random bytes where necessary, fake network metadata, and sentinel secrets. They do not require a real API key, browser, email service, external identity provider, or PostgreSQL.

### Admin bootstrap and password tests

- hidden-prompt CLI creates exactly one first admin and refuses a second initialization;
- password never appears in CLI arguments, output, logs, database snapshots, or process-facing configuration;
- each user receives a distinct random salt, and correct/incorrect scrypt verification behaves as specified;
- malformed and excessive-cost password encodings fail closed;
- unknown, disabled, missing-password, and incorrect-password paths execute the dummy/real verification boundary and return the same public result.

### Session and cookie tests

- raw session token appears only in `Set-Cookie`; SQLite stores only its SHA-256 digest;
- valid, missing, malformed, expired, revoked, and disabled-user sessions produce closed outcomes;
- logout is idempotent, revokes the digest, and clears the exact active cookie profile;
- production cookie is `__Host-agent_session; Secure; HttpOnly; SameSite=Lax; Path=/` with no Domain;
- insecure loopback cookie uses `agent_session`, never `__Host-`, and is accepted only under the explicit all-loopback flag matrix;
- no response or log contains sentinel password, cookie, session digest, or proxy token values.

### Boundary and startup tests

- protected routes reject cookie-only and proxy-token-only requests independently;
- login accepts proxy authentication without a prior session, while business routes do not;
- anonymous loopback is disabled by default;
- the fixture smoke path works only when the anonymous flag, non-production runtime, loopback bind, and all-loopback trusted origins are simultaneously true;
- wildcard, LAN, public, mixed-origin, or production configurations with either unsafe loopback flag fail startup and emit only a sanitized warning;
- anonymous fixture smoke cannot access admin-only routes.

### Rate-limit and authorization tests

- repeated failures exhaust either the email or IP bucket and return the same bounded public error;
- changing email does not bypass an exhausted IP bucket, and changing IP does not bypass an exhausted email bucket;
- limiter entry cleanup and maximum capacity keep memory bounded;
- browser-supplied forwarding headers are overwritten, and Agent Service ignores client-IP metadata until proxy authentication succeeds;
- member business actions succeed, member admin/status actions fail, admin status actions succeed, and cross-organization access fails without existence leakage.

## Rollout and Compatibility

Authentication is introduced fail closed. After 4.3, the default local and production behavior requires login. Existing fixture smoke remains available only through `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=1` under the all-loopback, non-production matrix; this compatibility switch is not a production rollback mechanism.

Rollout order:

1. add repository and crypto contracts against the existing `users` and `sessions` tables;
2. add the one-time admin CLI and create the first admin in the target environment;
3. add auth endpoints, session middleware, and role guards behind focused tests;
4. configure secure cookie transport and trusted origins;
5. enable protected routes and verify login/logout/session revocation;
6. keep legacy fixture smoke isolated under the explicit anonymous-loopback flag until those fixtures are converted to authenticated requests.

If the authenticated rollout must be paused locally, operators may temporarily use the anonymous-loopback flag only on an all-loopback non-production environment. Non-loopback and production deployments cannot roll back to anonymous access; they must restore the previous application build or fix authentication configuration. Existing sessions and user rows remain server-side and can be revoked without exposing raw tokens.

No 4.3 rollback deletes users, password hashes, sessions, or audit events. Schema and behavior changes must remain backward-readable for the previous build or be guarded by the normal deployment rollback procedure.

## Acceptance Boundary

OpenSpec 4.3 is ready for implementation only when the code plan preserves all of these invariants:

- proxy authentication and user-session authentication remain independent and mandatory on protected routes;
- no raw password or session token is persisted or logged;
- production and non-loopback deployments cannot enable anonymous or insecure-cookie compatibility modes;
- loopback fixture compatibility is explicit, narrow, non-admin, and still proxy-authenticated;
- unknown and disabled accounts do not create a practical enumeration shortcut;
- `member` cannot access admin-only status or secret-bearing operations;
- failures and logs remain sanitized;
- implementation does not expand into UI redesign, invitation/email, key management, or PostgreSQL.
