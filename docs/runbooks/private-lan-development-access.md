# Private LAN Development Access

This runbook enables one authenticated development Web instance at
`http://192.168.1.109:31900`. It supplements, and does not replace,
`docs/runbooks/agent-stack.md`.

The fixed topology is:

```text
LAN browser -> Web 0.0.0.0:31900
            -> same-origin /api/agent proxy
            -> Agent Service 127.0.0.1:31901
            -> PostgreSQL 127.0.0.1:58258
```

Only TCP `31900` may be reachable from the private LAN. Plain HTTP does not
protect traffic from other devices that can observe the LAN, so use this mode
only on a trusted Windows `Private` network and remove the rule when testing
ends. Never use it on a guest, shared, or Public-profile network.

## Prerequisites

- Run these commands from the `openspec-4-3-auth` worktree in an elevated
  PowerShell terminal.
- The machine must own `192.168.1.109`, and at least one connected network
  profile must already be `Private`. This procedure never changes the profile.
- PostgreSQL must remain bound to `127.0.0.1:58258`.
- Agent Service must remain bound to `127.0.0.1:31901`.
- Do not create a broad Node executable exception or any rule for `31901` or
  `58258`.
- If an existing named rule or an unexpected listener is present, stop and
  inspect it. Do not overwrite, remove, or kill an unknown resource.

Run this read-only host preflight before loading or starting anything:

```powershell
$lanAddress = Get-NetIPAddress -AddressFamily IPv4 -IPAddress '192.168.1.109' -ErrorAction Stop
$activePrivate = @(Get-NetConnectionProfile |
  Where-Object { $_.IPv4Connectivity -ne 'Disconnected' -and $_.NetworkCategory -eq 'Private' })
if ($activePrivate.Count -eq 0) { throw 'No active Private network profile' }
if (Get-NetFirewallRule -DisplayName 'Amazon Insights Web LAN Dev 31900' -ErrorAction SilentlyContinue) {
  throw 'Named firewall rule already exists; inspect it before continuing'
}
```

Expected: one assigned address, at least one active Private profile, and no
existing named rule. Any failure is a hard stop. In particular, do not switch
the profile automatically and do not broaden the firewall to compensate.

Observed on 2026-08-20: the machine owned `192.168.1.109/24`, the named rule
was absent, but the active Ethernet profile was `Public`. Acceptance therefore
stopped before firewall creation and before any LAN-bound stack startup. This
is an honestly recorded block, not a successful LAN acceptance.

## Load Runtime Environment

The private-network cookie profile fails closed unless all of these remain
true: the flag is exactly `1`, runtime is not production, Web uses the fixed
`31900` port and a valid local private/wildcard bind, Agent uses loopback and
the fixed `31901` port, the internal URL is the matching loopback URL, every
trusted origin is an explicit-port HTTP private/loopback literal, the exact
LAN origin is present, and the shared proxy token is non-empty. The private
and loopback insecure-cookie flags must not both be enabled. Authentication,
roles, sessions, origin checks, and proxy trust remain mandatory.

Use this secret-safe setup without printing the resulting values:

```powershell
$providerEnvPath = 'C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution\.env.local'
if (-not (Test-Path -LiteralPath $providerEnvPath -PathType Leaf)) {
  throw 'Protected provider environment file is unavailable'
}

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
$env:AGENT_VOC_LOCAL_FAKE = '0'
$env:AGENT_VOC_WORKER_OWNER_ID = 'private-lan-acceptance-192-168-1-109-31900'
$env:AGENT_SERVICE_PROXY_TOKEN = [Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).ToLowerInvariant()
$env:AGENT_DATABASE_URL = $databaseUrlLine[0].Substring('AGENT_DATABASE_URL='.Length)
```

PowerShell uses only `Test-Path` for `$providerEnvPath`; it must never call
`Get-Content` on, dot-source, copy, print, stage, or commit that external file.
Only Node reads it through `--env-file`. Current-process values—including the
exact LAN variables, ephemeral proxy token, PostgreSQL URL,
`AGENT_VOC_LOCAL_FAKE=0`, and the non-secret worker owner ID—take precedence
over duplicate provider-file names. Never echo a secret-bearing variable or
persist it in the repository.

Before starting an application process, run this silent, read-only PostgreSQL
preflight. It prevents idle acceptance from claiming queued work and calling a
provider:

```powershell
@'
import pg from "pg";
const client = new pg.Client({ connectionString: process.env.AGENT_DATABASE_URL });
try {
  await client.connect();
  const { rows } = await client.query(
    "SELECT count(*)::int AS active FROM job_attempts WHERE status IN ('queued', 'running')",
  );
  if (Number(rows[0]?.active) !== 0) {
    throw new Error("Active jobs block no-provider-call LAN acceptance");
  }
} finally {
  await client.end();
}
'@ | node --input-type=module -
```

Expected: exit `0` with no output. Any queued/running attempt blocks startup;
do not cancel, alter, or execute it here. Loading provider configuration proves
readiness only and does not authorize model, analysis, connector, or worker
activity.

## Focused Verification

Run the private-cookie/auth and wildcard-probe gates:

```powershell
npx tsx --conditions=react-server --test tests/agent/auth-config.test.ts tests/agent/auth-routes.test.ts tests/agent/service-security.test.ts tests/agent/session-auth.test.ts
node --test tests/scripts/start-agent-stack.test.mjs
```

Then run browser, proxy, safe-error, and lint regressions:

```powershell
npx tsx --conditions=react-server --test tests/agent/proxy.test.ts tests/agent/web-health.test.ts tests/agent/local-agent-browser.test.ts tests/agent/web-auth-session.test.ts
npx eslint server/config.ts tests/agent/auth-config.test.ts tests/agent/auth-routes.test.ts tests/agent/service-security.test.ts
git diff --check
```

All tests and lint must pass. `git diff --check` must not introduce a new
problem; any known unrelated user WIP remains untouched. Do not continue after
an affected-path failure.

## Build and Start

Run the plan's only build after focused verification:

```powershell
npm run build
```

Any build error blocks startup and firewall creation. Do not build again in
this acceptance. Never use `npm run stack:dev`; it is not the verified built
Web-proxy path.

Create and verify the exact firewall rule before starting. Then start the
built stack in its own terminal with:

```powershell
node --env-file="$providerEnvPath" .\scripts\start-agent-stack.mjs prod
```

Launcher mode `prod` selects the built Web server and non-watch Agent process;
the runtime remains `NODE_ENV=development` for this narrowly validated cookie
profile. Do not invoke a model, analysis, connector, or worker during this
acceptance.

## Private Firewall Rule

Only after the read-only preflight proves the active profile is `Private`, run:

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

Expected: exactly one enabled inbound allow rule. Reject any Windows prompt
that offers a broad Node executable exception. Never add a rule for `31901` or
`58258`.

## Host Checks

With the built stack running, execute from the elevated terminal:

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

Every assertion must complete silently and both health requests must return
`200`. A Web `503` or any listener mismatch blocks LAN login. Do not weaken
readiness, enable fake/provider mode, or expose another port.

## Second-Device Acceptance

From a second Windows device on the same Private subnet, run:

```powershell
$web = Test-NetConnection 192.168.1.109 -Port 31900 -WarningAction SilentlyContinue
$agent = Test-NetConnection 192.168.1.109 -Port 31901 -WarningAction SilentlyContinue
$postgres = Test-NetConnection 192.168.1.109 -Port 58258 -WarningAction SilentlyContinue
if (-not $web.TcpTestSucceeded) { throw 'Web LAN port is unreachable' }
if ($agent.TcpTestSucceeded) { throw 'Agent port is exposed to the LAN' }
if ($postgres.TcpTestSucceeded) { throw 'PostgreSQL port is exposed to the LAN' }
```

Expected: Web succeeds; Agent and PostgreSQL fail. Any opposite result blocks
browser acceptance.

Open `http://192.168.1.109:31900`. Retrieve the admin and member passwords
directly from the ACL-protected local credentials file; do not display or copy
them into notes. Verify all of the following without triggering analysis or a
connector:

- `test-admin@amazon-insights.local` logs in, has role `admin`, and can read an
  existing PostgreSQL-backed project and report.
- `test-member-1@amazon-insights.local` logs in, has role `member`, can read
  the same permitted project/report, and receives `403` from the admin
  connector route.
- The host-only cookie is `agent_session` with `HttpOnly`, `SameSite=Lax`,
  `Path=/`, `Secure=false`, and no `Domain`.
- Browser traffic never directly targets `31901` or `58258`, and browser state
  contains no proxy token, internal URL, database URL, or raw session token.
- Wrong current password remains an inline error; an expired session returns
  the application to the login gate.

If a second device is unavailable, record acceptance as blocked. Host-local
checks are not a substitute and must not be reported as second-device proof.

## Restart

Stop only the known launcher with `Ctrl+C` and confirm both child processes
exit. Do not terminate unrelated Node processes. Restart without another build:

```powershell
node --env-file="$providerEnvPath" .\scripts\start-agent-stack.mjs prod
```

Repeat the Host Checks and second-device acceptance. Both health endpoints
must return `200`; listener and firewall boundaries must remain exact; the
same existing project/report must remain readable. Do not run analysis or
mutate accounts or data.

## Rollback

Log out the LAN browser sessions, stop the known launcher, confirm its children
exit, and remove only the exact named rule:

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

Restart the already built output only if local post-rollback verification is
needed:

```powershell
node --env-file="$providerEnvPath" .\scripts\start-agent-stack.mjs prod
```

Expected: local Web and Agent health remain available on loopback, the named
rule is absent, second-device TCP `31900` fails, and neither Agent nor
PostgreSQL is exposed. No account, data, credential, or database rollback is
part of this procedure. Stop the stack after recording evidence.
