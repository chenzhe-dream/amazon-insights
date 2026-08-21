# Twenty-User Fake Concurrency Runbook

This runbook records safe fake-provider capacity evidence only. Do not paste provider payloads, passwords, cookies, headers, API keys, database URLs, or raw upstream responses here.

## Scope

- Isolated PostgreSQL image: `postgres:16-alpine`
- Isolated Agent process: random loopback port per run
- Provider mode: deterministic fake provider
- Real providers, live ports `31900/31901`, live PostgreSQL, and real accounts: not used

## Command

```powershell
npm run smoke:concurrency:fake
```

For RED proof only, intentionally bypass the SellerSprite fake cap:

```powershell
$env:FAKE_PROVIDER_DELIBERATE_CAP_VIOLATION = "1"
npm run smoke:concurrency:fake
Remove-Item Env:\FAKE_PROVIDER_DELIBERATE_CAP_VIOLATION
```

## Evidence Template

Fill this after a clean run. Record only counts, timestamps, safe job IDs, maxima, and pass/fail.

| Run | Timestamp | Accepted | Terminal | Max whole jobs | Max SellerSprite/SIF/Sorftime/model/image | SellerSprite 60s attempts | Max PG connections | Result |
|---|---|---:|---:|---:|---|---:|---:|---|
| 1 | 2026-08-22T07:47+08:00 | 20 | 20 completed / 0 failed | 4 | 2 / 1 / 1 / 1 / 1 | 24 | 10 | pass |
| 2 | 2026-08-22T07:48+08:00 | 20 | 20 completed / 0 failed | 4 | 2 / 1 / 1 / 1 / 1 | 24 | 10 | pass |

Run 1 safe job IDs:

```text
27f9382c-0d83-46b2-ba7d-2a72935626f7
e06de5aa-6957-481a-b537-d6e28cefedb2
ee8a5e01-c20d-42ca-a30c-5ce3c8329071
47135b44-8f70-4b66-9370-86d6aa6f3fa4
97fae2c2-6067-45e4-9e30-c0c7ad93510f
3e47caf5-75dc-4c1d-9163-68904dc3845a
64085742-1706-4f4b-a95b-b680728ca1e0
00f8769b-2839-434f-9731-5ec31ae81f63
2384197c-3194-4a2e-9c8d-336b269803df
b9f36458-809a-4b50-a106-30acc3da4748
710a6839-f1e4-4e40-9c5d-627971da9af6
c85a55de-d0b5-46de-a85a-742051fe9c36
9317f75d-d403-4b15-aafc-1799fe7e8db2
cebc9224-4d74-427d-8e1f-2866e7c6b825
2ccb5e4d-70a4-4acb-a03e-448a598848fa
af1e6e0c-6424-461c-8504-a4ed11f91cab
3490fefc-7e12-4b85-bf9d-2e647a5ee365
50cf5520-95fb-4b3b-9052-2aeaab62ffad
6cb21269-4e61-4e8a-b11a-15c371676d5b
dc5c916e-fa44-4029-a9a8-94f7d2856958
```

Run 2 safe job IDs:

```text
dc88630a-e3c5-4762-bd53-e8be62ff3024
a4890752-44e2-4704-9d8f-e43dab8afc2e
8e818f16-346d-4933-b594-61104dd8da6a
50de774b-abee-43aa-aa2e-b6d611645311
8afbcc61-c32d-498a-8808-21774440b5fc
8e8323d5-ba89-4438-9910-c1117be8b39b
fa251ad4-0895-44bf-9c84-9e28a6ba743c
8cd15727-1bac-493a-b124-0b6d20186622
40fd0da3-2428-4a4d-a327-d11a6426043e
0c71e42d-aa6a-4dcc-8b32-d9909433de1a
4ac8c906-f47c-4fbe-8dbc-e5a4852c59a0
48e07c5a-bf63-4ccb-8b01-a9a697127664
edef5142-ebf8-4f1a-9c45-001434d1749f
cf5f30ad-4091-4272-85c1-1941a3527b9f
022680ba-925c-4665-a2c6-5e81a0257256
67f8dd61-79ab-4d88-b64b-b0affed4df10
8abd569d-8b4e-4b1c-94e9-4d506f8fd214
7710efdf-406b-4765-9c8d-abbdcfa264d0
83cac527-f5ff-482a-bd83-cc7ea88c947a
689d62b7-a5d8-49e3-b175-80e8e78aacda
```

Additional RED evidence: with `FAKE_PROVIDER_DELIBERATE_CAP_VIOLATION=1`, the tracer failed on the expected invariant: `sellerSprite concurrency exceeded: 12`.

## Rollback

No production state is changed by this smoke. If the tracer fails, stop any remaining fake Agent process, remove the temporary test container, and rerun after the failing invariant is understood.
