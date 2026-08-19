# Agent Stack Runbook

## Process Model

The production baseline uses exactly two application processes on one host:

- Web: vinext, default `http://127.0.0.1:3001`
- Agent Service: Fastify API plus three worker loops in the same Node process,
  default `http://127.0.0.1:3100`

Do not add a third worker process manager for MVP. The optional stack launcher
only starts children, waits for health, forwards one shutdown signal, and
cleans up the peer on unexpected exit. It does not restart, daemonize, or
persist state.

## Required Environment

Both processes must share the same `AGENT_SERVICE_PROXY_TOKEN`.

Web:

```text
AGENT_SERVICE_INTERNAL_URL=http://127.0.0.1:3100
AGENT_SERVICE_PROXY_TOKEN=<same-long-random-value>
HOST=127.0.0.1
PORT=3001
```

Agent Service:

```text
AGENT_SERVICE_HOST=127.0.0.1
AGENT_SERVICE_PORT=3100
AGENT_SERVICE_PROXY_TOKEN=<same-long-random-value>
AGENT_SERVICE_TRUSTED_ORIGINS=http://127.0.0.1:3001,http://localhost:3001
```

The Web browser calls same-origin `/api/agent/v1/*`. The Web proxy adds the
internal token and forwards only the approved request headers. Do not expose
port `3100` publicly.

## Storage

Empty `AGENT_DATABASE_URL` selects SQLite:

```text
AGENT_DATABASE_URL=
AGENT_SQLITE_PATH=./data/agent-service.sqlite
AGENT_SQLITE_BUSY_TIMEOUT_MS=5000
```

Non-empty `AGENT_DATABASE_URL` selects PostgreSQL and must use
`postgres://` or `postgresql://`. Invalid values fail closed during Agent
Service startup. PostgreSQL production runs must provide one shared database
for Web restarts and Agent Service restarts to observe the same durable runs,
leases, snapshots, and reports.

## Local Fixture Flags

These flags are allowed only for local fixture smoke runs where all bind hosts
and trusted origins are loopback and `NODE_ENV` is not `production`:

```text
AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=1
AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE=1
AGENT_VOC_LOCAL_FAKE=1
```

Production must keep anonymous access, insecure cookies, and fake providers
disabled.

## Commands

```powershell
npm run build
npm run stack:start
```

For local development:

```powershell
npm run stack:dev
```

For the PostgreSQL restart smoke after a production build:

```powershell
npm run smoke:stack:postgres
```

## Health

- Agent Service: `GET http://127.0.0.1:3100/health`
- Web: `GET http://127.0.0.1:3001/api/health`

Web health probes Agent Service with a two-second bound. A healthy Agent returns
`200` with `agent: "ok"`. Missing, invalid, refused, timed-out, or malformed
Agent health returns generic `503 degraded` without the internal URL or error
details.
