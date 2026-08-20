# Private LAN Development Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow authenticated development access at `http://192.168.1.109:31900` while keeping the Agent Service and PostgreSQL loopback-only and failing closed for every unsafe cookie/origin/bind configuration.

**Architecture:** Extend the existing authentication configuration resolver with one independent private-network cookie profile, using injected network-interface discovery for deterministic tests and retaining the current cookie serializer and exact-origin middleware. Keep launcher mode `prod` independent from runtime `NODE_ENV=development`, probe a wildcard Web bind through loopback, and put the Windows firewall plus real-LAN procedure in a separate runbook so current runbook WIP is not touched.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9, Fastify 5, Zod 4, Node `test` through `tsx`, vinext production build/server, PowerShell and Windows Defender Firewall.

## Global Constraints

- The LAN URL is exactly `http://192.168.1.109:31900`.
- Web binds `0.0.0.0:31900`; Agent Service remains `127.0.0.1:31901`; PostgreSQL remains `127.0.0.1:58258`.
- The new flag is exactly `AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE=1`; any value other than canonical `0`, canonical `1`, or absence fails through the existing canonical flag policy.
- The private-network cookie profile is allowed only when `NODE_ENV` is not `production`, Agent host is loopback, every trusted origin is plain HTTP with a permitted RFC1918/localhost host and an explicit port, Web host is `0.0.0.0` or an RFC1918 IPv4 address assigned to this machine, the exact LAN origin uses the Web port, the internal Agent URL stays loopback, and `AGENT_SERVICE_PROXY_TOKEN` is non-empty.
- Permitted RFC1918 IPv4 ranges are exactly `10.0.0.0/8`, `172.16.0.0/12`, and `192.168.0.0/16`; permitted local names/literals are exactly `localhost`, `127.0.0.0/8`, and `[::1]`.
- Reject production, exposed Agent bind, public/non-RFC1918 Web bind, unassigned private Web bind, public/non-RFC1918 trusted origin, arbitrary DNS hostname, wildcard origin, HTTPS/mixed origin list, implicit port, empty origin list, missing proxy token, non-loopback internal Agent URL, and simultaneous insecure private-network/loopback flags.
- In the accepted profile, the cookie is `agent_session`, remains `HttpOnly`, `SameSite=Lax`, `Path=/`, has no `Domain`, and has `Secure=false`; logout clears the exact same profile.
- Existing secure production behavior and `AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE` behavior remain unchanged; `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK` remains `0` for the LAN workflow.
- The browser continues to use same-origin `/api/agent/v1/*`; it never receives `AGENT_SERVICE_PROXY_TOKEN` and never calls port `31901` or `58258` directly.
- Windows Firewall opens only TCP `31900`, only for `LocalAddress=192.168.1.109`, `RemoteAddress=LocalSubnet`, and `Profile=Private`; never add a rule for `31901` or `58258`, Public/Any profile, a broad range, or the Node executable.
- Plain HTTP is for a trusted Private-profile development LAN only. Do not use it on a guest/shared network, and remove the rule and flag after acceptance.
- The acceptance launcher is one fresh `npm run build` followed by `npm run stack:start` (equivalent to `node ./scripts/start-agent-stack.mjs prod`) while runtime `NODE_ENV=development`; never use `stack:dev` for this acceptance.
- Do not add dependencies, migrations, account/user/password changes, HTTPS/certificates, public hosting, Cloudflare, router forwarding, tunnels, provider calls, connector changes, or generated data.
- Never print, log, stage, or commit passwords, cookies, session values, proxy tokens, `AGENT_DATABASE_URL`, credential-file content, or environment files.
- Preserve all existing dirty/untracked WIP. In particular, do not modify or stage the current `docs/runbooks/agent-stack.md` WIP; use the new dedicated runbook below.
- Each task ends in one normal new commit. Do not amend, push, rebase, reset, stash, clean, or stage a broad directory.

---

## Exact File Map

**Create:**

- `docs/runbooks/private-lan-development-access.md` — exact Windows Private firewall, built-stack startup, LAN evidence, restart, and rollback procedure.

**Modify:**

- `server/config.ts` — parse and fail-close the new cookie profile without changing existing secure or loopback behavior.
- `scripts/start-agent-stack.mjs` — use loopback for the health probe when Web binds `0.0.0.0`; retain the public LAN URL/bind and `prod` launcher selection.
- `.env.example` — document safe defaults for Web host/port and the new flag as `0`.
- `tests/agent/auth-config.test.ts` — exact positive matrix, negative matrix, interface injection, default/loopback regressions, and safe error text.
- `tests/agent/auth-routes.test.ts` — login/logout cookie attributes under the resolved LAN profile.
- `tests/agent/service-security.test.ts` — exact LAN origin, near-match rejection, proxy-token-only, and cookie-only denial.
- `tests/scripts/start-agent-stack.test.mjs` — wildcard bind, loopback health probe, production-style child selection, and preserved `NODE_ENV=development`.

**Verify without modification:**

- `server/auth/session.ts` and `tests/agent/session-auth.test.ts` — existing secure/insecure serializers already produce the required attributes.
- `app/lib/agent-service-client.ts` and `tests/agent/proxy.test.ts` — existing server-side proxy token and Cookie/Set-Cookie sanitization remain unchanged.
- `app/api/health/route.ts` and `tests/agent/web-health.test.ts` — existing generic degraded responses remain secret-free.
- `tests/agent/local-agent-browser.test.ts` and `tests/agent/web-auth-session.test.ts` — current endpoint-specific `401` behavior remains unchanged.
- `docs/runbooks/agent-stack.md` — protected pre-existing WIP; do not edit or stage it.

## Stable Interfaces

`AgentAuthenticationConfig` does not gain a new public mode or cookie shape. The new profile resolves to the existing authenticated/insecure-cookie representation:

```ts
Readonly<{
  mode: "authenticated";
  cookie: Readonly<{
    name: "agent_session";
    secure: false;
    maxAgeSeconds: 28_800;
  }>;
  sessionTtlMs: 28_800_000;
  loginLimiter: Readonly<{
    windowMs: 900_000;
    maxFailures: 5;
    maxEntries: 10_000;
  }>;
}>;
```

The only signature extension is an optional deterministic network reader. All existing one-argument callers keep their behavior:

```ts
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type NetworkInterfaceReader =
  () => NodeJS.Dict<NetworkInterfaceInfo[]>;

export function loadAgentAuthenticationConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readNetworkInterfaces: NetworkInterfaceReader = networkInterfaces,
): AgentAuthenticationConfig;
```

`resolveStackSettings(env, "prod")` keeps its existing return type. For `WEB_HOST=0.0.0.0`, `settings.web.host` remains `0.0.0.0`, while `settings.web.healthUrl` becomes `http://127.0.0.1:31900/api/health`.

---

### Task 1: Fail-Closed Private-Network Cookie Configuration and Launcher Validation

**Files:**
- Modify: `server/config.ts`
- Modify: `scripts/start-agent-stack.mjs`
- Modify: `.env.example`
- Test: `tests/agent/auth-config.test.ts`
- Test: `tests/agent/auth-routes.test.ts`
- Test: `tests/agent/service-security.test.ts`
- Test: `tests/scripts/start-agent-stack.test.mjs`
- Verify: `tests/agent/session-auth.test.ts`
- Verify: `tests/agent/proxy.test.ts`
- Verify: `tests/agent/web-health.test.ts`
- Verify: `tests/agent/local-agent-browser.test.ts`
- Verify: `tests/agent/web-auth-session.test.ts`

**Interfaces:**
- Consumes: existing `canonicalFlag()`, `parseTrustedOrigins()`, `isLoopbackHost()`, `AgentAuthenticationConfig`, cookie serializers, exact trusted-origin Set checks, and stack launcher `env` propagation.
- Produces: the `NetworkInterfaceReader` and extended `loadAgentAuthenticationConfig(env, readNetworkInterfaces)` signature above; no new HTTP route, shared contract, database type, or browser interface.

- [ ] **Step 1: Add the assigned-interface fixture and exact positive RED test.** Add this fixture and test to `tests/agent/auth-config.test.ts`:

```ts
const privateLan = {
  NODE_ENV: "development",
  WEB_HOST: "0.0.0.0",
  WEB_PORT: "31900",
  AGENT_SERVICE_HOST: "127.0.0.1",
  AGENT_SERVICE_PORT: "31901",
  AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:31901",
  AGENT_SERVICE_PROXY_TOKEN: "private-lan-proxy-token-sentinel",
  AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:31900",
  AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "0",
  AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "0",
  AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE: "1",
};

const assignedLanInterfaces = () => ({
  Ethernet: [{
    address: "192.168.1.109",
    netmask: "255.255.255.0",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:01",
    internal: false,
    cidr: "192.168.1.109/24",
  }],
});

test("agent authentication accepts the exact private-LAN development matrix", () => {
  const config = loadAgentAuthenticationConfig(
    privateLan,
    assignedLanInterfaces,
  );
  assert.equal(config.mode, "authenticated");
  assert.deepEqual(config.cookie, {
    name: "agent_session",
    secure: false,
    maxAgeSeconds: 28_800,
  });
});
```

- [ ] **Step 2: Add the closed negative matrix RED test.** In the same test file, enumerate every forbidden dimension and assert the one safe error message. Keep sentinels out of the thrown message:

```ts
test("agent authentication rejects unsafe private-LAN cookie matrices", () => {
  const invalid = [
    { ...privateLan, NODE_ENV: "production" },
    { ...privateLan, AGENT_SERVICE_HOST: "0.0.0.0" },
    { ...privateLan, AGENT_SERVICE_HOST: "192.168.1.109" },
    { ...privateLan, AGENT_SERVICE_INTERNAL_URL: "http://192.168.1.109:31901" },
    { ...privateLan, AGENT_SERVICE_INTERNAL_URL: "https://127.0.0.1:31901" },
    { ...privateLan, AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:31902" },
    { ...privateLan, AGENT_SERVICE_PROXY_TOKEN: "" },
    { ...privateLan, WEB_HOST: "203.0.113.9" },
    { ...privateLan, WEB_HOST: "192.168.1.110" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "https://192.168.1.109:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://203.0.113.9:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://lan-host:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://*.example:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://user:pass@192.168.1.109:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:31900/path" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:31900?query=1" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:31900#fragment" },
    {
      ...privateLan,
      AGENT_SERVICE_TRUSTED_ORIGINS:
        "http://192.168.1.109:31900,http://203.0.113.9:31900",
    },
    { ...privateLan, AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "1" },
    { ...privateLan, AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1" },
    { ...privateLan, AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE: "yes" },
  ];

  for (const env of invalid) {
    assert.throws(
      () => loadAgentAuthenticationConfig(env, assignedLanInterfaces),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Agent authentication configuration is invalid",
        );
        assert.doesNotMatch(
          error.message,
          /private-lan-proxy-token-sentinel|192\.168\.1\.109|AGENT_DATABASE_URL/,
        );
        return true;
      },
    );
  }
});
```

Also add positive rows where `localhost`, `127.0.0.1`, and `[::1]` are additional trusted origins beside the exact assigned LAN origin. Test `10.0.0.8` and `172.16.0.8` as the matching LAN origin with the same address present in the injected interface map. Add boundary rejection for `172.15.255.255` and `172.32.0.0`. Every configured origin uses an explicit port.

- [ ] **Step 3: Add HTTP and launcher RED tests.** In `tests/agent/auth-routes.test.ts`, resolve `privateLanAuthConfig` from the exact environment and injected interfaces, then use it for a login/logout test. In `tests/agent/service-security.test.ts`, use the exact LAN origin and assert near matches fail. In `tests/scripts/start-agent-stack.test.mjs`, add the wildcard-bind case:

```ts
test("private-LAN prod launcher keeps development guard env and probes wildcard Web through loopback", async () => {
  const settings = resolveStackSettings({
    NODE_ENV: "development",
    WEB_HOST: "0.0.0.0",
    WEB_PORT: "31900",
    AGENT_SERVICE_HOST: "127.0.0.1",
    AGENT_SERVICE_PORT: "31901",
  }, "prod");

  assert.equal(settings.mode, "prod");
  assert.equal(settings.web.host, "0.0.0.0");
  assert.equal(settings.web.port, 31900);
  assert.equal(settings.web.healthUrl, "http://127.0.0.1:31900/api/health");
  assert.equal(settings.agent.internalUrl, "http://127.0.0.1:31901");
});
```

The auth route assertion must match the complete attribute boundary:

```ts
assert.match(cookie, /^agent_session=/);
assert.match(cookie, /Path=\//);
assert.match(cookie, /HttpOnly/);
assert.match(cookie, /SameSite=Lax/);
assert.doesNotMatch(cookie, /Secure|Domain=/i);
```

The service-security test sends `origin` values `http://192.168.1.109:31901`, `http://192.168.1.110:31900`, and `https://192.168.1.109:31900` with the valid proxy token and expects `403 FORBIDDEN`. It then proves a valid cookie without `x-agent-proxy-token` returns `401 AUTHENTICATION_REQUIRED`, while a valid proxy token without a session cannot access a session-required business route.

- [ ] **Step 4: Run the RED tests and record the expected failures.** Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/auth-config.test.ts tests/agent/auth-routes.test.ts tests/agent/service-security.test.ts
node --test tests/scripts/start-agent-stack.test.mjs
```

Expected: FAIL because the new flag currently resolves the secure `__Host-agent_session` cookie instead of `agent_session`, unsafe private matrices do not fail closed, and wildcard Web health currently targets `http://0.0.0.0:31900/api/health` instead of loopback. Existing secure and loopback tests must remain green inside the failing run.

- [ ] **Step 5: Add exact private-origin parsing helpers to `server/config.ts`.** Import `networkInterfaces` and `NetworkInterfaceInfo`, define `NetworkInterfaceReader`, and add these focused helpers next to the existing loopback helpers:

```ts
type ParsedPrivateOrigin = Readonly<{
  origin: string;
  hostname: string;
  port: number;
}>;

function ipv4Octets(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  return octets.every((value) =>
    Number.isInteger(value) && value >= 0 && value <= 255,
  ) ? octets : null;
}

function isRfc1918Host(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function parsePrivateOrigins(value: string | undefined): ParsedPrivateOrigin[] {
  const parsed: ParsedPrivateOrigin[] = [];
  for (const item of value?.split(",") ?? []) {
    const candidate = item.trim();
    if (!candidate) continue;
    const authority = candidate.match(
      /^http:\/\/(\[[^\]]+\]|[^:/?#]+):([1-9]\d*)\/?$/i,
    );
    if (!authority) throw new Error("Agent authentication configuration is invalid");
    const port = Number(authority[2]);
    if (!Number.isInteger(port) || port > 65_535) {
      throw new Error("Agent authentication configuration is invalid");
    }
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      (!isLoopbackHost(hostname) && !isRfc1918Host(hostname))
    ) {
      throw new Error("Agent authentication configuration is invalid");
    }
    parsed.push({ origin: url.origin, hostname, port });
  }
  if (parsed.length === 0) {
    throw new Error("Agent authentication configuration is invalid");
  }
  return parsed;
}

function assignedPrivateIpv4(
  readNetworkInterfaces: NetworkInterfaceReader,
): ReadonlySet<string> {
  const assigned = new Set<string>();
  for (const entries of Object.values(readNetworkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === "IPv4" && isRfc1918Host(entry.address)) {
        assigned.add(entry.address);
      }
    }
  }
  return assigned;
}
```

Keep `parseTrustedOrigins()` unchanged for ordinary secure and loopback profiles. The private parser is an additional stricter gate and must not broaden accepted service origins.

- [ ] **Step 6: Implement the private-network predicate and wire the new flag.** Add one helper that checks the proxy token, loopback Agent/internal URL, Web bind, assigned interface, Web port, and at least one configured LAN origin matching the assigned machine address and Web port:

```ts
function assertPrivateNetworkCompatibilityAllowed(
  env: AgentEnvironment,
  readNetworkInterfaces: NetworkInterfaceReader,
): void {
  const fail = () => {
    throw new Error("Agent authentication configuration is invalid");
  };
  if (env.NODE_ENV === "production" || !env.AGENT_SERVICE_PROXY_TOKEN?.trim()) fail();

  const agentHost = env.AGENT_SERVICE_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(agentHost)) fail();

  let agentPort: number;
  let webPort: number;
  let internalUrl: URL;
  let origins: ParsedPrivateOrigin[];
  try {
    agentPort = canonicalPositiveInteger(
      env.AGENT_SERVICE_PORT ?? "3100",
      "Agent authentication configuration is invalid",
    );
    webPort = canonicalPositiveInteger(
      env.WEB_PORT ?? env.PORT ?? "3001",
      "Agent authentication configuration is invalid",
    );
    internalUrl = new URL(
      env.AGENT_SERVICE_INTERNAL_URL ?? `http://${agentHost}:${agentPort}`,
    );
    origins = parsePrivateOrigins(env.AGENT_SERVICE_TRUSTED_ORIGINS);
  } catch {
    fail();
  }

  if (
    internalUrl!.protocol !== "http:" ||
    internalUrl!.username ||
    internalUrl!.password ||
    internalUrl!.search ||
    internalUrl!.hash ||
    (internalUrl!.pathname !== "/" && internalUrl!.pathname !== "") ||
    !isLoopbackHost(internalUrl!.hostname) ||
    Number(internalUrl!.port || "80") !== agentPort!
  ) fail();

  const assigned = assignedPrivateIpv4(readNetworkInterfaces);
  const webHost = (env.WEB_HOST ?? env.HOST ?? "127.0.0.1").trim();
  if (
    webHost !== "0.0.0.0" &&
    (!isRfc1918Host(webHost) || !assigned.has(webHost))
  ) fail();

  const expectedHost = webHost === "0.0.0.0" ? null : webHost;
  const hasExactLanOrigin = origins!.some((origin) =>
    isRfc1918Host(origin.hostname) &&
    assigned.has(origin.hostname) &&
    origin.port === webPort! &&
    (expectedHost === null || origin.hostname === expectedHost),
  );
  if (!hasExactLanOrigin) fail();
}
```

Wire it without changing the existing loopback predicate:

```ts
const insecurePrivateNetworkCookie = canonicalFlag(
  env.AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE,
);
if (
  insecurePrivateNetworkCookie &&
  (anonymousLoopback || insecureCookie)
) {
  throw new Error("Agent authentication configuration is invalid");
}
if (anonymousLoopback || insecureCookie) {
  assertLoopbackCompatibilityAllowed(env);
}
if (insecurePrivateNetworkCookie) {
  assertPrivateNetworkCompatibilityAllowed(env, readNetworkInterfaces);
}
const allowInsecureCookie = insecureCookie || insecurePrivateNetworkCookie;
```

Use `allowInsecureCookie` for the existing cookie `name` and `secure` fields. Do not add a third authentication `mode`; role/session enforcement remains `authenticated`.

- [ ] **Step 7: Make wildcard Web health probing loopback-safe.** In `scripts/start-agent-stack.mjs`, keep the bind host unchanged and derive only the probe host:

```js
function healthProbeHost(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host;
}

const webProbeHost = healthProbeHost(webHost);

// In the returned web settings:
healthUrl: `http://${webProbeHost}:${webPort}/api/health`,
```

Do not change `web.host`, child `HOST`, child `PORT`, `argv`-based `prod`/`dev` selection, or `NODE_ENV` propagation.

- [ ] **Step 8: Add safe example defaults.** Update `.env.example` with `WEB_HOST=127.0.0.1`, `WEB_PORT=3001`, and:

```dotenv
# Authenticated private-LAN HTTP development only. The Agent and database
# remain loopback-only; production and unsafe origin/bind matrices fail closed.
AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE=0
```

Do not place the machine-specific LAN enablement or any real token/URL secret in the example file.

- [ ] **Step 9: Run focused GREEN tests.** Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/auth-config.test.ts tests/agent/auth-routes.test.ts tests/agent/service-security.test.ts tests/agent/session-auth.test.ts
node --test tests/scripts/start-agent-stack.test.mjs
```

Expected: all selected tests PASS. The exact LAN matrix resolves `agent_session` without `Secure`; every negative row throws only the generic auth configuration error; secure defaults and the existing loopback flag tests remain unchanged; wildcard bind is still `0.0.0.0` but probes through `127.0.0.1`.

- [ ] **Step 10: Run browser/proxy/error regressions without building.** Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/proxy.test.ts tests/agent/web-health.test.ts tests/agent/local-agent-browser.test.ts tests/agent/web-auth-session.test.ts
npx eslint server/config.ts tests/agent/auth-config.test.ts tests/agent/auth-routes.test.ts tests/agent/service-security.test.ts
git diff --check
```

Expected: all selected tests PASS; Web health errors remain generic; proxy token/cookie sanitization and endpoint-specific `401` behavior remain unchanged; ESLint and diff check exit `0`.

- [ ] **Step 11: Commit Task 1 with explicit paths only.** Run:

```powershell
git add -- .env.example server/config.ts scripts/start-agent-stack.mjs tests/agent/auth-config.test.ts tests/agent/auth-routes.test.ts tests/agent/service-security.test.ts tests/scripts/start-agent-stack.test.mjs
git diff --cached --name-only
git diff --cached --check
git commit -m "feat(auth): allow private LAN development cookies"
```

Expected staged list: exactly the seven paths above. No runbook WIP, environment file, database, generated data, or unrelated test is staged.

---

### Task 2: Windows Private Firewall Runbook and Real LAN Acceptance

**Files:**
- Create: `docs/runbooks/private-lan-development-access.md`
- Verify only: Task 1 files, protected PostgreSQL credential source, running PostgreSQL container, Windows network/firewall state, built Web/Agent processes, and second-device browser/network state
- Do not modify: `docs/runbooks/agent-stack.md`, `.env.local`, account data, credentials, or database data

**Interfaces:**
- Consumes: Task 1 private-network flag, existing protected PostgreSQL endpoint `127.0.0.1:58258`, current authenticated Web flow, and existing `build`/`stack:start` scripts.
- Produces: one secret-free operational runbook and one real acceptance result; no runtime API, new script, firewall helper, user/account, or database change.

- [ ] **Step 1: Create the runbook boundary and runtime setup.** Create `docs/runbooks/private-lan-development-access.md` with these exact sections: `Prerequisites`, `Load Runtime Environment`, `Focused Verification`, `Build and Start`, `Private Firewall Rule`, `Host Checks`, `Second-Device Acceptance`, `Restart`, and `Rollback`. In the first two sections, copy the fixed topology, fail-closed matrix summary, plain-HTTP risk, and no-secret rule from the approved spec. State that `docs/runbooks/agent-stack.md` is not replaced.

Use this secret-safe runtime setup verbatim; it reads the protected PostgreSQL URL without printing it and generates an ephemeral shared proxy token in process memory:

```powershell
$postgresCredentialPath = 'C:\Users\EDY\AppData\Local\Temp\amazon-insights-postgres-credentials-20260820-094538.env'
$databaseUrlLine = @(Get-Content -LiteralPath $postgresCredentialPath |
  Where-Object { $_ -like 'AGENT_DATABASE_URL=*' })
if ($databaseUrlLine.Count -ne 1) { throw 'Protected PostgreSQL configuration is unavailable' }

$env:NODE_ENV = 'development'
$env:WEB_HOST = '0.0.0.0'
$env:WEB_PORT = '31900'
$env:AGENT_SERVICE_HOST = '127.0.0.1'
$env:AGENT_SERVICE_PORT = '31901'
$env:AGENT_SERVICE_INTERNAL_URL = 'http://127.0.0.1:31901'
$env:AGENT_SERVICE_TRUSTED_ORIGINS = 'http://192.168.1.109:31900'
$env:AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE = '1'
$env:AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE = '0'
$env:AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK = '0'
$env:AGENT_SERVICE_PROXY_TOKEN = [Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).ToLowerInvariant()
$env:AGENT_DATABASE_URL = $databaseUrlLine[0].Substring('AGENT_DATABASE_URL='.Length)
```

The runbook must say not to echo any of the last three secret-bearing variables and not to persist them to a repository file.

- [ ] **Step 2: Add the RED/GREEN and one-build gates to the runbook.** The focused gate reuses Task 1 Step 9 and Step 10 commands. After they pass, the runbook contains the plan's only build command:

```powershell
npm run build
```

Expected: exit `0`; warnings may be recorded, but any build error blocks firewall creation and LAN startup. Do not run another build during this plan. Do not start the stack until the Private-profile preflight and exact firewall rule in Steps 3–4 pass. `npm run stack:dev` is explicitly forbidden for this acceptance.

- [ ] **Step 3: Add and perform the read-only host preflight.** Put this command in `Prerequisites`, then use an elevated PowerShell terminal to verify the machine owns `192.168.1.109`, the active profile is Private, and the named rule does not already exist:

```powershell
$lanAddress = Get-NetIPAddress -AddressFamily IPv4 -IPAddress '192.168.1.109' -ErrorAction Stop
$activePrivate = @(Get-NetConnectionProfile |
  Where-Object { $_.IPv4Connectivity -ne 'Disconnected' -and $_.NetworkCategory -eq 'Private' })
if ($activePrivate.Count -eq 0) { throw 'No active Private network profile' }
if (Get-NetFirewallRule -DisplayName 'Amazon Insights Web LAN Dev 31900' -ErrorAction SilentlyContinue) {
  throw 'Named firewall rule already exists; inspect it before continuing'
}
```

Expected: one assigned address, at least one active Private profile, and no existing named rule. If any check fails, stop; do not change the network profile or broaden the firewall.

- [ ] **Step 4: Add exactly one scoped firewall rule.** Put this command in `Private Firewall Rule` and run it only after Step 3:

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

Expected: exactly one enabled inbound allow rule. Do not accept a Windows prompt that creates a broad Node executable rule, and do not create any rule for `31901` or `58258`.

- [ ] **Step 5: Start the built stack, then perform firewall, listener, and health checks.** After the exact rule exists, start the proven built-server path in a dedicated terminal:

```powershell
npm run stack:start
```

Expected startup: launcher mode is `prod`, runtime `NODE_ENV` remains `development`, Agent becomes healthy before Web starts, and neither child exits. Put the following checks in `Host Checks`, then run them from the elevated terminal:

```powershell
$rule = Get-NetFirewallRule -DisplayName 'Amazon Insights Web LAN Dev 31900' -ErrorAction Stop
$portFilter = $rule | Get-NetFirewallPortFilter
$addressFilter = $rule | Get-NetFirewallAddressFilter
if ($rule.Profile -ne 'Private' -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow') {
  throw 'Firewall rule policy is broader than approved'
}
if ($portFilter.Protocol -ne 'TCP' -or $portFilter.LocalPort -ne '31900') {
  throw 'Firewall port scope is broader than approved'
}
if ($addressFilter.LocalAddress -notcontains '192.168.1.109' -or
    $addressFilter.RemoteAddress -notcontains 'LocalSubnet') {
  throw 'Firewall address scope is broader than approved'
}

$listeners = @(Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in 31900,31901,58258 })
if (-not ($listeners | Where-Object { $_.LocalPort -eq 31900 -and $_.LocalAddress -eq '0.0.0.0' })) {
  throw 'Web is not listening on the approved wildcard port'
}
if (-not ($listeners | Where-Object { $_.LocalPort -eq 31901 -and $_.LocalAddress -eq '127.0.0.1' })) {
  throw 'Agent is not loopback-only'
}
if (-not ($listeners | Where-Object { $_.LocalPort -eq 58258 -and $_.LocalAddress -eq '127.0.0.1' })) {
  throw 'PostgreSQL is not loopback-only'
}

$agentHealth = Invoke-WebRequest 'http://127.0.0.1:31901/health' -UseBasicParsing
$webHealth = Invoke-WebRequest 'http://192.168.1.109:31900/api/health' -UseBasicParsing
if ($agentHealth.StatusCode -ne 200 -or $webHealth.StatusCode -ne 200) {
  throw 'Built stack health check failed'
}
```

Expected: all assertions complete silently; both health requests return `200`. A generic Web `503` or any listener mismatch blocks LAN login; do not weaken readiness, enable a fake/provider mode, or expose another port to proceed.

- [ ] **Step 6: Add and perform second-device port isolation.** Put this command in `Second-Device Acceptance`, then run it from a second Windows device on the same Private subnet:

```powershell
$web = Test-NetConnection 192.168.1.109 -Port 31900 -WarningAction SilentlyContinue
$agent = Test-NetConnection 192.168.1.109 -Port 31901 -WarningAction SilentlyContinue
$postgres = Test-NetConnection 192.168.1.109 -Port 58258 -WarningAction SilentlyContinue
if (-not $web.TcpTestSucceeded) { throw 'Web LAN port is unreachable' }
if ($agent.TcpTestSucceeded) { throw 'Agent port is exposed to the LAN' }
if ($postgres.TcpTestSucceeded) { throw 'PostgreSQL port is exposed to the LAN' }
```

Expected: Web succeeds; Agent and PostgreSQL fail from the second device. Any opposite result blocks browser acceptance.

- [ ] **Step 7: Perform second-device authenticated browser acceptance.** Add the following checklist to `Second-Device Acceptance`, then open `http://192.168.1.109:31900`. Use the `test-admin@amazon-insights.local` and `test-member-1@amazon-insights.local` entries from the ACL-protected file `C:\Users\EDY\AppData\Local\Temp\amazon-insights-test-users-dUKfGM\credentials.txt` without displaying or copying passwords into notes. Verify:

- admin login returns `200`, the confirmed session role is `admin`, and an existing PostgreSQL-backed project and report are readable;
- member login returns `200`, role is `member`, the same permitted project/report reads work, and the admin connector route remains `403`;
- the browser cookie is host-only `agent_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure=false`, and has no `Domain`;
- no request goes directly to `31901` or `58258`, no proxy token/URL/database secret appears in browser state, and no analysis/provider/connector action is triggered;
- wrong-current-password remains an inline error, while a genuinely expired session returns the gate to login.

Expected: every item passes. If the second device is unavailable or any port/cookie/role assertion fails, record the safe failure and do not claim LAN acceptance.

- [ ] **Step 8: Verify built-stack restart persistence without another build.** Add this procedure to `Restart`. Stop only the launcher with `Ctrl+C`, confirm both Web and Agent children exit, then re-run:

```powershell
npm run stack:start
```

Expected: both health endpoints return `200`, the listener/firewall assertions from Step 5 still pass, and the same existing project/report remain readable from the second device after login. Do not run analysis or mutate accounts/data.

- [ ] **Step 9: Add, execute, and verify rollback.** Put this exact procedure in `Rollback`. Log out both browser sessions, stop the launcher, and remove only the named rule:

```powershell
Get-NetFirewallRule -DisplayName 'Amazon Insights Web LAN Dev 31900' -ErrorAction Stop |
  Remove-NetFirewallRule

Remove-Item Env:AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE -ErrorAction SilentlyContinue
$env:WEB_HOST = '127.0.0.1'
$env:WEB_PORT = '3001'
$env:AGENT_SERVICE_HOST = '127.0.0.1'
$env:AGENT_SERVICE_PORT = '3100'
$env:AGENT_SERVICE_INTERNAL_URL = 'http://127.0.0.1:3100'
$env:AGENT_SERVICE_TRUSTED_ORIGINS = 'http://127.0.0.1:3001,http://localhost:3001'
```

Restart with the already built output through `npm run stack:start`. Expected: local Web/Agent health remains available on loopback, the named firewall rule is absent, second-device TCP `31900` fails, no listener exposes Agent/PostgreSQL, and no account/data/database rollback occurs. Stop the stack after recording evidence.

- [ ] **Step 10: Commit only the dedicated runbook after acceptance or an honestly recorded block.** The runbook contains expected commands and safe stop conditions, never credentials or claimed evidence that was not observed. Run:

```powershell
git add -- docs/runbooks/private-lan-development-access.md
git diff --cached --name-only
git diff --cached --check
git commit -m "docs: add private LAN development runbook"
git status --short
```

Expected staged list: only `docs/runbooks/private-lan-development-access.md`. Final status still shows all pre-existing WIP, including `docs/runbooks/agent-stack.md`, as unstaged; no environment file, database, generated data, or secret artifact is committed.

---

## Plan Self-Review

- [x] **Spec coverage:** Task 1 covers the explicit flag, exact topology inputs, assigned-interface injection, RFC1918/localhost and explicit-port origin policy, missing token/internal URL checks, insecure cookie attributes, safe errors, unchanged secure/loopback modes, exact request-origin enforcement, and launcher `prod` versus `NODE_ENV`. Task 2 covers the dedicated runbook, one build, built-stack start, Private-only firewall, listeners, second-device admin/member acceptance, restart persistence, and rollback/removal.
- [x] **Completeness:** Every path, function, RED/GREEN failure, safe stop, command, and commit boundary is explicit; no deferred implementation marker or secret stand-in remains.
- [x] **Type consistency:** `NetworkInterfaceReader`, `ParsedPrivateOrigin`, `loadAgentAuthenticationConfig(env, readNetworkInterfaces)`, and existing `AgentAuthenticationConfig` cookie fields have one spelling and one owner throughout.
- [x] **Command consistency:** The only acceptance launcher is `stack:start`; launcher mode `prod` is explicitly distinct from `NODE_ENV=development`. The plan runs exactly one build, and restart/rollback reuse that output.
- [x] **Firewall safety:** One fixed-name rule opens TCP `31900` only for `192.168.1.109`, `LocalSubnet`, and `Private`; read-only preflight blocks collisions and unsafe profiles; rollback deletes only that exact rule; `31901` and `58258` are never opened.
- [x] **Regression safety:** Existing production secure cookies, loopback insecure cookies, anonymous-loopback restrictions, roles, session expiry, endpoint-specific password `401`, proxy token, Web error redaction, PostgreSQL data, and current user WIP remain unchanged.
