# Private LAN Development Access Design

**Date:** 2026-08-20

**Status:** Approved design; implementation not started

**Scope:** Allow one authenticated development Web instance to be used from the private LAN without exposing the Agent Service or PostgreSQL

## Goal

Make the existing authenticated application reachable at:

`http://192.168.1.109:31900`

The minimal topology is:

```text
LAN browser
  -> HTTP Web 192.168.1.109:31900 (process binds 0.0.0.0:31900)
  -> same-origin /api/agent proxy
  -> Agent Service 127.0.0.1:31901
  -> PostgreSQL 127.0.0.1:58258
```

Only TCP port `31900` is reachable from the private LAN. The browser never calls the Agent Service or PostgreSQL directly, and it never receives the internal proxy token.

## Decision

Add one explicit environment flag:

```dotenv
AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE=1
```

The flag enables an insecure-cookie compatibility profile only for authenticated, non-production development on a private network. It does not enable anonymous access, bypass the proxy token, widen route authorization, or make a general HTTP deployment mode.

Plain HTTP provides no transport confidentiality against another device able to observe local-network traffic. This exception is therefore limited to a trusted Private-profile development LAN, must not be used on guest/shared networks, and must be removed when the session ends. The loopback-only Agent and database bindings, proxy token, authenticated sessions, and exact origin policy reduce exposure but do not turn HTTP into HTTPS.

This is preferred over the following alternatives:

1. Binding the Agent Service to the LAN would expose a security-sensitive internal API and make the proxy token the only network boundary.
2. Reusing `AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE` would silently weaken its all-loopback invariant and make existing configuration misleading.
3. Adding local certificates or a public tunnel would solve a broader deployment problem, but adds certificate, DNS, or third-party ingress work outside this minimal development need.

The existing `AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE` behavior remains unchanged. The two insecure-cookie flags represent distinct profiles and must not both be `1`; an ambiguous combination fails startup.

## Exact Development Configuration

The approved instance uses these non-secret values:

```dotenv
NODE_ENV=development
WEB_HOST=0.0.0.0
WEB_PORT=31900
AGENT_SERVICE_HOST=127.0.0.1
AGENT_SERVICE_PORT=31901
AGENT_SERVICE_INTERNAL_URL=http://127.0.0.1:31901
AGENT_SERVICE_TRUSTED_ORIGINS=http://192.168.1.109:31900
AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE=1
AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE=0
AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=0
```

`AGENT_SERVICE_PROXY_TOKEN` remains required and must contain the same long random secret in the Web proxy and Agent Service process environments. It must not be placed in browser-visible configuration or committed files.

Storage remains the already verified PostgreSQL instance on `127.0.0.1:58258`. `AGENT_DATABASE_URL` is loaded from the existing protected local secret source and is never printed or copied into this specification. This change does not alter, publish, or migrate the database.

The stack launcher passes the resolved Web host and port to the Web child, keeps `AGENT_SERVICE_INTERNAL_URL` on loopback, and validates the private-network cookie profile before accepting traffic. A configuration failure terminates startup instead of falling back to a weaker profile.

The approved startup path uses the proven built Web server rather than the vinext development/Cloudflare path:

```powershell
npm run build
npm run stack:start
```

`npm run stack:start` is equivalent to `node ./scripts/start-agent-stack.mjs prod`. Here, launcher mode `prod` selects the non-watch Agent process and built Web server; it does not set or imply `NODE_ENV=production`. The runtime environment deliberately retains `NODE_ENV=development` solely so the Agent's private-network insecure-cookie guard can pass. The guard still rejects an actual `NODE_ENV=production` runtime.

The operator loads the approved runtime environment and protected secrets before `stack:start`. Startup acceptance requires a successful build, Web and Agent health, PostgreSQL connectivity, and listener inspection; Web readiness alone is insufficient. `npm run stack:dev` is not an acceptance path for this design because its vinext development/Cloudflare route has not provided the persistent healthy Web proxy required by the verified local workflow.

## Fail-Closed Security Matrix

The new flag is accepted only when every condition in the `Allowed` column is true.

| Input | Allowed | Rejected examples |
| --- | --- | --- |
| Flag | Exact canonical value `1` | `true`, `yes`, malformed values, or both insecure-cookie flags enabled |
| Runtime | `NODE_ENV` is not `production` | `NODE_ENV=production` |
| Agent bind | Loopback only; the approved value is `127.0.0.1` | `0.0.0.0`, an RFC1918 address, a public address, or an arbitrary hostname |
| Web bind | `0.0.0.0` or an RFC1918 IPv4 address assigned to this machine; approved value is `0.0.0.0` | Public address, loopback-only address for this LAN mode, wildcard names, or a private address not assigned locally |
| Trusted origins | Non-empty; every entry is plain `http`, has an explicit port, and uses only a permitted private/localhost host; the exact approved origin is present | HTTPS/mixed schemes, implicit port, credentials, path, query, fragment, public origin, arbitrary DNS name, or empty list |
| Proxy token | Non-empty valid `AGENT_SERVICE_PROXY_TOKEN` | Missing or blank token |

A permitted trusted-origin host is one of:

- an IPv4 literal in `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16`;
- the literal hostname `localhost`;
- an IPv4 loopback literal in `127.0.0.0/8`; or
- the IPv6 loopback literal `[::1]`.

Other hostnames are rejected even if DNS currently resolves them to a private address. This avoids DNS rebinding and resolution-time ambiguity. Wildcard origins such as `*`, `http://*.example`, or a host-only allowlist are never accepted. Origin comparison remains exact after safe URL canonicalization; `http://192.168.1.109:31900` does not authorize a different host, scheme, or port.

An explicit port must appear in the configured origin text. The validator must not allow URL normalization to turn an implicit or default port into an apparently explicit one.

The approved Web bind `0.0.0.0` means listen on local interfaces; it is not a trusted origin and must never appear in `AGENT_SERVICE_TRUSTED_ORIGINS`. The browser-facing origin uses the machine address `192.168.1.109`.

### Mode Resolution

| New private-network flag | Existing loopback flag | Environment | Result |
| ---: | ---: | --- | --- |
| `0` | `0` | Any otherwise valid configuration | Existing secure-cookie behavior |
| `0` | `1` | Existing all-loopback, non-production matrix | Existing insecure loopback behavior, unchanged |
| `1` | `0` | Every private-network predicate above passes | Insecure private-network development cookie |
| `1` | `0` | Any predicate fails | Sanitized startup error; no listener accepted as ready |
| `1` | `1` | Any | Sanitized startup error |
| `1` | `0` | Production | Sanitized startup error |

The private-network flag affects cookie transport only. Authentication and role authorization remain mandatory, and `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK` remains `0` for this workflow.

## Cookie Profile

When the private-network mode is valid, login issues a host-only cookie with these attributes:

```text
agent_session=<opaque value>; Path=/; HttpOnly; SameSite=Lax
```

`Secure` is false only in this accepted development mode, so the cookie can travel over the approved plain-HTTP LAN origin. The cookie has no `Domain` attribute and does not use the `__Host-` prefix, which requires `Secure`. Logout clears the exact same profile.

Outside this mode, the existing defaults remain intact:

- production and ordinary authenticated configurations use `__Host-agent_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain`;
- the existing all-loopback development flag continues to issue its current `agent_session` profile only under its current validation matrix.

React code still cannot read the HttpOnly cookie. Passwords, raw session tokens, session hashes, database credentials, and proxy tokens remain excluded from JSON responses, URLs, logs, Web Storage, and application persistence.

## Request Flow

1. A device on the same private network opens `http://192.168.1.109:31900`.
2. The Web application calls same-origin `/api/agent/v1/auth/session`. The browser sends the host-only session cookie when one exists.
3. The server-side Web proxy removes any browser-supplied internal headers, attaches its own `AGENT_SERVICE_PROXY_TOKEN`, preserves the exact browser `Origin` when applicable, and calls `http://127.0.0.1:31901`.
4. The Agent Service verifies the proxy token, exact trusted origin policy, session, organization, and route role. Cookie-only or proxy-token-only protected requests still fail independently.
5. The Agent Service returns a bounded contract response. The Web proxy sanitizes headers and body before returning it to the browser.
6. Login, logout, password change, feedback, project, run, and report requests continue through the same path. No direct LAN route to ports `31901` or `58258` exists.

The current endpoint-specific `401` behavior remains: invalid current-password errors stay local to the password modal, while `AUTHENTICATION_REQUIRED` expires the Web authentication gate.

## Windows Firewall Boundary

Before creating the rule, the operator confirms that the active Windows network profile is `Private`. The approved inbound rule is scoped to the machine address, local subnet, TCP port `31900`, and Private profile:

```powershell
New-NetFirewallRule `
  -DisplayName 'Amazon Insights Web LAN Dev 31900' `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalAddress 192.168.1.109 `
  -LocalPort 31900 `
  -RemoteAddress LocalSubnet `
  -Profile Private
```

No rule is added for Agent port `31901` or PostgreSQL port `58258`. No rule uses the Public profile, `Any` profile, an application-wide Node executable exception, or a broad port range. A Windows consent prompt that proposes a broader Node firewall exception is not an acceptable substitute.

The implementation/manual acceptance must inspect the resulting rule and listeners, not infer safety from a successful browser request. Expected listeners are Web on `0.0.0.0:31900`, Agent on `127.0.0.1:31901`, and PostgreSQL on `127.0.0.1:58258`.

## Safe Errors and Observability

Configuration is validated before the stack is reported ready. Invalid private-network mode produces one generic operator-facing error such as `Private-network development authentication configuration is invalid` and a stable non-secret reason code suitable for tests. It does not echo:

- the proxy token or whether a guessed token matched;
- `AGENT_DATABASE_URL` or any credential file content;
- cookies, session values, password material, or request authorization headers; or
- a serialized environment object or stack trace in a browser response.

The Web health route remains generic when the Agent fails configuration. The browser sees the existing safe unavailable/configuration response, not internal topology or validation details. Logs may state the selected safe mode name and a bounded reason code, but never environment values or secrets.

Requests from an untrusted origin, without the proxy token, or without a valid session use the existing sanitized `403`, proxy-auth failure, or `401` contract behavior. The mode must not retry a rejected request with origin or authentication checks disabled.

## TDD Acceptance Cases

Implementation proceeds test-first and covers at least these cases.

### Configuration RED/GREEN cases

1. The exact approved non-production environment resolves Web `0.0.0.0:31900`, Agent `127.0.0.1:31901`, internal URL `http://127.0.0.1:31901`, trusted origin `http://192.168.1.109:31900`, and an insecure `agent_session` cookie.
2. Binding Web to the machine's assigned RFC1918 address instead of `0.0.0.0` is accepted.
3. The new flag is rejected in production, with an exposed Agent bind, with a public or non-RFC1918 Web bind, or with an RFC1918 Web bind not assigned to the machine.
4. An empty trusted-origin list, public origin, HTTPS origin, arbitrary hostname, wildcard, omitted port, credentials, path, query, or fragment fails closed. Mixed lists fail when any one entry is invalid.
5. Missing or blank `AGENT_SERVICE_PROXY_TOKEN` fails closed before readiness.
6. Enabling both insecure-cookie flags fails closed.
7. With the new flag off, secure-cookie defaults are unchanged. With only the existing loopback flag on, its current positive and negative tests remain unchanged.
8. Safe configuration errors contain no sentinel proxy token, database URL, cookie, password, session token, or complete environment value.
9. Stack resolution with launcher mode `prod` and `NODE_ENV=development` selects the built Web server, non-watch Agent, and approved ports while passing `NODE_ENV=development` to the runtime guard. A regression must not conflate launcher mode with the runtime environment.

Tests that validate an assigned RFC1918 interface inject a deterministic network-interface reader; they do not depend on the test machine's current address.

### HTTP and browser cases

10. Login from the exact LAN origin through the Web proxy succeeds, sets `agent_session` with `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, and no `Secure`, then the session GET authenticates.
11. Logout clears the exact insecure private-network cookie profile.
12. A near-match origin with a different host, scheme, or port is rejected; public and wildcard origins never reach protected business handling.
13. A direct request to Agent port `31901` without the proxy token is rejected even with a valid cookie. A proxy-token-only protected request is rejected without a session.
14. Admin/member authorization, password-change error semantics, session expiry, CSRF/trusted-origin checks, limiter behavior, and response redaction remain unchanged.
15. The browser receives no proxy token, database URL, raw session token, internal Agent URL, or unsafe startup detail.

### Manual network cases

16. Run `npm run build`, then start the approved runtime with `npm run stack:start` and `NODE_ENV=development`; do not substitute `npm run stack:dev`. Confirm the built Web proxy and Agent remain healthy long enough to complete the full acceptance flow.
17. From a second device on the same private subnet, `http://192.168.1.109:31900` loads and an authenticated admin and member can read their permitted existing data.
18. From that device, ports `31901` and `58258` are unreachable.
19. The Windows firewall rule reports `Profile=Private`, `Protocol=TCP`, `LocalPort=31900`, `LocalAddress=192.168.1.109`, and `RemoteAddress=LocalSubnet`; no task-created rule covers `31901` or `58258`.
20. Restarting with `npm run stack:start` preserves PostgreSQL-backed project/report reads and session behavior without changing the listener boundary or changing `NODE_ENV` from `development`.

Focused automated gates should cover Agent auth configuration, stack settings, auth routes/session cookies, service security/trusted origins, Web proxy behavior, Web health redaction, and existing loopback compatibility tests. The final gate includes the affected build and a listener/firewall inspection.

## Rollback and Removal

Rollback requires no database change:

1. Log out LAN browser sessions or revoke the development sessions if immediate invalidation is required.
2. Stop the stack.
3. Remove `AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE`, restore `WEB_HOST=127.0.0.1` and the normal Web port, and restore the trusted origins to the intended loopback origins.
4. Keep `AGENT_SERVICE_HOST=127.0.0.1`; do not add rules for the Agent or database.
5. Remove only the named firewall rule:

```powershell
Get-NetFirewallRule -DisplayName 'Amazon Insights Web LAN Dev 31900' -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule
```

6. Restart the already built application with `npm run stack:start`; if the checked-out code changed, run `npm run build` first. The rollback also uses the built-server path, not `npm run stack:dev`.
7. Verify the Web, Agent, and PostgreSQL listeners are loopback-only as intended and `http://192.168.1.109:31900` is no longer reachable from the LAN.

The feature can be removed later by deleting the new flag parser/profile and its focused tests after all deployed environments have removed the flag. Existing loopback-cookie behavior and regression coverage must remain intact. Host-only cookies already stored by LAN browsers expire normally or are cleared by logout; no account, password, project, report, feedback, or migration rollback is part of removal.

## Non-Goals

- HTTPS, certificate generation, local certificate trust, DNS, or certificate rotation.
- Public Internet hosting, router port forwarding, UPnP, reverse tunnels, Cloudflare, or any other ingress service.
- Exposing the Agent Service, PostgreSQL, connector endpoints, or internal proxy token to the LAN.
- Changing users, roles, passwords, seeded accounts, sessions beyond normal login/logout, or organization membership.
- Anonymous LAN access or widening `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK`.
- New account registration, invitation, password reset, account administration, or identity-provider integration.
- Database migration, data copy, credential rotation, connector/provider changes, or analysis behavior changes.
- General support for public IPs, arbitrary hostnames, wildcard origins, insecure production cookies, or multi-machine Agent/database deployment.

## Completion Boundary

This design is complete when the exact LAN URL works from a second private-network device with authenticated sessions, only Web port `31900` is reachable, Agent and PostgreSQL remain loopback-only, the fail-closed matrix and cookie attributes pass automated tests, the firewall scope is verified, and rollback removes LAN access without changing application data or accounts.
