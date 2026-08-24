# SellerSprite MCP Handshake Design

## Status and decision

This design records the approved **Approach A** for the existing
`stabilize-resumable-sync-pipeline` change. It fixes only the SellerSprite MCP
session contract. It does not broaden the OpenSpec change, alter SIF or
Sorftime behavior, or authorize implementation, probing, deployment, or job
creation.

The current production SellerSprite probe sends a stateless JSON-RPC
`tools/list` request directly to the public `/mcp` endpoint. A single bounded
diagnostic proved DNS, TCP, and TLS are healthy and the endpoint returns HTTP
400 for that request. The repository has no MCP SDK dependency, and the
current client does not perform `initialize`, negotiate a protocol version, or
retain an MCP session identifier.

The selected design uses the standard MCP `Client` with
`StreamableHTTPClientTransport` for SellerSprite only. Each logical connector attempt opens a
fresh session with `connect()`, lets the SDK negotiate `initialize` and session
metadata, performs exactly one `listTools()` or `callTool()`, and closes the
client in `finally`.

## Goals

- Make SellerSprite readiness use a protocol-correct MCP handshake before
  listing tools.
- Make SellerSprite business operations use the same handshake before calling
  a tool.
- Preserve the existing public endpoint and server-side `secret-key` header.
- Preserve bounded timeout, sanitized errors, tenant credential resolution,
  concurrency admission, rolling request accounting, and readiness fail-closed
  behavior.
- Keep readiness free of ASINs and product-tool calls.
- After deployment, allow the already-saved three-ASIN project to be submitted
  once only after a successful SellerSprite capability probe.

## Non-goals

- No change to SIF or Sorftime transports, probes, credentials, retries, or
  parsing.
- No ASIN-specific fallback, endpoint override, readiness bypass, timeout
  inflation, automatic job creation, new job/run/stage type, or database
  migration.
- No persistence of MCP session identifiers and no session sharing across
  organizations, credentials, probes, attempts, or jobs.
- No SellerSprite product tool during readiness.
- No changes to SellerSprite quota refresh, image analysis, traffic parsing,
  Sorftime degradation, or the existing saved project.

## Considered approaches

### A. Standard MCP Client plus Streamable HTTP transport — selected

Use the official MCP client lifecycle for SellerSprite: construct a `Client`
and `StreamableHTTPClientTransport`, `connect()`, then `listTools()` for
readiness or `callTool()` for a business operation, then close. The SDK owns
protocol-version and session header negotiation.

This adds one focused runtime dependency but avoids maintaining a partial MCP
state machine and directly covers the HTTP 400 boundary observed in production.

### B. Hand-code initialize and session headers — rejected

Extend the current raw fetch client with manual `initialize`, protocol-version,
session-id, and close handling. This avoids a dependency but duplicates a
stateful protocol, is likely to drift, and makes cancellation and session
cleanup harder to prove.

### C. Change only the readiness method — rejected

Treat another endpoint or a known tool call as SellerSprite readiness while
leaving business calls stateless. This can report a false healthy state, may
consume product quota, and does not prove that the execution path can establish
the required MCP session.

## Dependency impact and implementation gate

`@modelcontextprotocol/sdk` is absent from `package.json`, `package-lock.json`,
`pnpm-lock.yaml`, and the installed `node_modules`. The repository's documented
installation path is npm and `package-lock.json` v3 is the current authoritative
lock used by the runbook.

Implementation therefore requires one new production dependency:
`@modelcontextprotocol/sdk`. The implementation plan must select and pin one
exact release that:

1. supports Node.js `>=22.13.0`;
2. exports `Client` and `StreamableHTTPClientTransport` used by this design;
3. supports abortable or otherwise bounded connection and request lifecycle;
4. exposes deterministic client/transport close semantics; and
5. permits internal reconnect/retry behavior to remain disabled; and
6. permits an injected fetch implementation so every protocol HTTP exchange
   can pass through the existing resource governor.

The dependency is not added during this design phase. Implementation must use
`npm install` so `package.json` and `package-lock.json` are updated together; it
must not hand-edit dependency resolutions. If the selected SDK cannot meet the
five requirements above, implementation stops before production code changes
rather than weakening the design.

## Architecture

### Existing boundaries retained

- `RemoteMcpConnector` continues to own the bounded FIFO limiter, logical
  attempt timeout, existing outer retry policy, structured-result validation,
  credential-leak rejection, and fixed `ConnectorError` projection.
- `ConnectorCredentialService` continues resolving the current organization’s
  managed credential first and the server environment credential second.
- `ConnectorProbeService` remains the only production path that persists
  connector health.
- `SyncProviderReadinessService` continues requiring a fresh available state
  before sync admission; no unavailable connector may create a job.

### SellerSprite-only session adapter

A small SellerSprite session adapter replaces only the current raw
SellerSprite request implementation. It accepts the already-resolved credential,
public endpoint, abort signal, request kind, and governor scope. It never logs
or returns the credential, endpoint query data, response body, raw SDK error,
session id, or request headers.

For every logical connector attempt it creates a fresh SDK client and a fresh
`StreamableHTTPClientTransport` configured with:

- the existing public `https://mcp.sellersprite.com/mcp` endpoint;
- the existing `secret-key` request header;
- JSON and event-stream response support supplied by the SDK; and
- the parent attempt’s abort signal and deadline; and
- a governed fetch implementation that is the only network dispatch seam.

The SDK, not application code, negotiates protocol version and the MCP session
identifier. The identifier remains in memory only for that client lifetime.

### Governance of handshake subrequests

The handshake introduces an initialization HTTP exchange before the operation
exchange. Both must remain governed and auditable.

For SellerSprite only, every HTTP dispatch made by the SDK transport uses an
injected governed fetch. This includes initialize, any protocol-required
initialized notification, `listTools()` or `callTool()`, and any networked
session cleanup. Each dispatch uses the same organization, job/probe identifier,
attempt kind, abort signal, and remaining total deadline. The shared connector
does not add a duplicate outer SellerSprite governor record around the complete
session.

This preserves the existing concurrency ceiling and rolling physical-request
accounting without a new table or policy. A failed connect never invokes
`listTools()` or `callTool()`. SIF and Sorftime continue using their existing
outer governed fetch behavior.

The selected SDK must not perform hidden redirects, reconnects, or retries.
Every call of the injected fetch is observable in the fake-server tests and
must have one matching governor record. If the transport cannot inject fetch or
disable unobservable dispatches, implementation is blocked because the governor
could no longer account for every external request.

## Request flows

### Readiness probe

1. The authenticated highest-admin route invokes the existing probe service.
2. The current organization’s SellerSprite credential is resolved server-side.
3. The connector acquires its existing bounded local slot.
4. A fresh SDK `Client` and `StreamableHTTPClientTransport` are created.
5. `connect()` performs MCP initialization and session negotiation; each SDK
   network dispatch passes through governed fetch.
6. `listTools()` verifies the session can enumerate capabilities through the
   same governed fetch.
7. The client is closed in `finally`.
8. Only the existing safe available/unavailable health record is persisted.

The readiness path must invoke no `tools/call`, include no ASIN, and create no
project, sync job, analysis run, run stage, or snapshot.

### SellerSprite tool execution

1. The shared connector validates the non-empty requested operation and resolves
   the tenant credential.
2. A fresh session performs `connect()` with every network dispatch governed.
3. The adapter performs one `callTool({name, arguments})` through the same
   governed fetch.
4. The result is projected into the existing object/array connector contract.
5. The client closes in `finally`.

No session is reused across logical attempts. A shared-connector retry, when
allowed by the existing policy, creates a new client and repeats the full
bounded lifecycle. The SDK adds zero retries; the existing outer policy remains
the only logical retry owner and is not increased.

## Timeout, cancellation, and closing

- The current per-attempt timeout remains the single total deadline for
  `connect()` plus `listTools()` or `callTool()`; handshake time does not receive
  a second timeout budget.
- Parent cancellation aborts the same lifecycle and prevents a subsequent
  operation from starting.
- SDK reconnect and request retry are disabled. There is no additional retry
  beyond the existing shared connector policy.
- `client.close()` is called exactly once in `finally`, including connect,
  operation, parse, timeout, and cancellation failures.
- Timeout first aborts the in-flight transport, then performs bounded local
  close. Cleanup must not wait indefinitely.
- Normal close does not call `terminateSession()` as an extra network request.
  If a selected SDK version makes network termination implicit, that request
  must be governed and counted; otherwise that SDK version is rejected.
- Session ids and client objects are discarded after close and never persisted.

## Error and secrecy contract

The adapter converts SDK and transport failures into the existing structural
error inputs consumed by `RemoteMcpConnector`; raw SDK messages and causes do
not cross the adapter boundary.

- HTTP 400 and other non-authentication 4xx responses map to the existing fixed
  non-retryable upstream failure.
- HTTP 401/403 map to the existing fixed authentication failure.
- Deadline or parent abort maps to the existing fixed timeout failure.
- HTTP 429 and 5xx retain the existing bounded retry classification.
- Invalid MCP negotiation, missing session metadata when required, RPC failure,
  or invalid result shape maps to a fixed safe protocol/malformed failure.

Responses, persisted connector status, logs, and tests must not contain the
credential, raw header values, endpoint query data, response body, certificate,
session id, SDK error message, database URL, token, or cookie. Safe evidence is
limited to connector id, operation class, fixed error code, attempt count,
checked time, and bounded phase booleans/timings where already authorized.

## Test design

All tests use a loopback fake MCP server and fake credentials. They perform no
real SellerSprite, SIF, Sorftime, Amazon, model, or image request.

### Protocol RED

The fake SellerSprite server rejects `tools/list` before initialization with
HTTP 400. It accepts `initialize`, returns a negotiated protocol version and a
session id, and requires that session on subsequent requests. The current
stateless SellerSprite probe must fail this test before implementation.

### Protocol GREEN

After implementation, tests require:

- `connect()` sends initialize before any list/call operation;
- negotiated protocol version is accepted and the required protocol/session
  headers are present on the subsequent request;
- readiness performs the SDK-required handshake plus exactly one `listTools()`,
  with zero `tools/call` and zero ASIN/product arguments;
- execution performs the SDK-required handshake plus exactly one `callTool()`;
- failure during initialize performs no list/call;
- the client and transport close once on success, HTTP 400, timeout, malformed
  MCP response, and parent cancellation;
- no hidden SDK retry, redirect, reconnect, or ungoverned post-close request
  occurs;
- every HTTP dispatch observed by injected fetch is admitted and recorded by
  the existing SellerSprite governor, including protocol-required handshake
  notifications, with no duplicate outer accounting;
- HTTP 400 and timeout return only their fixed safe connector errors;
- captured logs, health rows, public responses, and serialized errors contain
  no credential, header value, body, session id, endpoint, token, or secret
  sentinel.

### Regression and admission

- Existing SIF and Sorftime connector tests must prove their request counts,
  URLs, authentication styles, direct `tools/list` probes, and tool calls are
  unchanged.
- Credential precedence and cross-organization isolation remain unchanged.
- A successful SellerSprite `connect()+listTools()` persists available health
  and permits the existing readiness gate.
- Any handshake/list failure persists unavailable health; the saved-project
  submission remains rejected before any sync job/run/stage insert.
- Existing bounded queue, outer retry, governor, and secret-sanitization suites
  remain green.

## Deployment and acceptance sequence

Implementation may deploy only after focused protocol tests, connector and
readiness regressions, lint, production build, and one limited independent
review report Critical 0 and direct blocker 0.

The controlled deployment keeps PostgreSQL running and verifies Web 31900,
Agent 31901, PostgreSQL 58258, port 3000 absent, migrations 15/15, formal fake
disabled, active work zero, served artifact identity, and protected generated
business data unchanged.

After those gates:

1. the authenticated highest administrator performs one SellerSprite capability
   probe;
2. SIF and Sorftime are not re-probed unless their existing freshness contract
   requires it;
3. only when all required connector states are available and active work is
   zero, reuse saved project `4d49aafa-029d-41b2-a101-c8891048f857` containing
   `B0FN7L65C1`, `B0GZSTTBVW`, and `B0GL22N4GY`;
4. submit that saved project exactly once; and
5. monitor the single job to terminal state without automatic replacement or
   duplicate submission.

The acceptance result must report truthful per-ASIN/module gaps. This design
does not redefine traffic, image, Alexa, or Sorftime acceptance semantics.

## OpenSpec relationship

This document refines the existing connector credential/probe and fail-closed
readiness requirements in
`openspec/changes/stabilize-resumable-sync-pipeline`. It does not add a new
OpenSpec change or modify the current proposal, design, specifications, or task
status during this documentation-only phase.
