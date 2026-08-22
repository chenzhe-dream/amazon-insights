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

For RED proof only, keep the production governor enabled but lower the tracer's
expected SellerSprite cap to 1:

```powershell
$env:FAKE_PROVIDER_DELIBERATE_CAP_VIOLATION = "1"
npm run smoke:concurrency:fake
Remove-Item Env:\FAKE_PROVIDER_DELIBERATE_CAP_VIOLATION
```

## Evidence Template

Fill this after a clean run. Record only counts, timestamps, safe job IDs, maxima, and pass/fail.

| Run | Timestamp | Accepted | Terminal | Max whole jobs | Max SellerSprite/SIF/Sorftime/model/image | SellerSprite 60s attempts | Max PG connections | Result |
|---|---|---:|---:|---:|---|---:|---:|---|
| 1 | 2026-08-22T08:05+08:00 | 20 | 20 completed / 0 failed | 4 | 2 / 1 / 1 / 2 / 2 | 24 | 10 | pass |
| 2 | 2026-08-22T08:06+08:00 | 20 | 20 completed / 0 failed | 4 | 2 / 1 / 1 / 2 / 2 | 24 | 10 | pass |

The connector maxima above are backed by direct PostgreSQL active-permit samples from `concurrency_resource_permits`, grouped by resource. SellerSprite rolling attempts are backed by `concurrency_physical_attempts`. Fake-provider events are used only to cross-check that every fake physical start has exactly one production-recorded DB attempt.

Run 1 safe job IDs:

```text
7753dce1-336b-48ee-bf1b-50ea9786c559
f7c902f6-7ed7-473f-8630-2680bfa7a678
1dc786c5-5d32-4f4f-8a0c-41a144807607
5b234e7c-7d03-42af-9f03-141923978622
cbef8e89-5ff0-4c82-b6a8-e72457c44b07
a5539c5b-5439-4931-99be-86af62a64f1a
6c3368be-8c9d-4935-b956-c3995de9f032
ebfa8234-e66f-45b3-9a63-ed77d2107b04
b61cdc96-3a38-4412-a5e5-bad4ff638e3c
5b26b1f2-90f2-45b1-ae97-3ac5fd2e4f81
cfa9c3b6-970e-403f-9830-4978461f198d
9f289dfa-477b-4325-8a8a-0b103896018f
9f3d3611-be5f-4f86-907d-2974fd7b0e9f
b2eae644-aa9f-4dbb-9dab-df7b3afe73cd
d95695ae-6f0c-4a4f-90ef-063d8142d99f
ec5a8d58-4914-49f4-bd3e-b11e52c053dd
db1538ae-cc63-4d91-8aa0-67ab951f50b2
eca1690c-5317-4519-982d-964dd1cd7530
d9885a97-7fc4-45f1-ab80-1ed8a16d461b
e5055098-02cb-42dc-81bf-e8b591d49ab1
```

Run 2 safe job IDs:

```text
8b2c958d-55aa-453c-8b73-73dd79bec5ed
383de4fb-927c-4a64-a704-f0aedc57dbc3
43ffa284-2eec-4d22-b36d-c3d1531408b3
41b3094a-8a77-4eed-99af-3890cafc755f
edfb49fa-ef06-4c60-b94d-0241c6c6c98b
5b5c6042-8dd9-42d7-b577-e59216bddc94
f98207bd-ee35-4aea-ab33-3d8d9b75837a
68143156-e525-46e4-a510-b6f342cc86c7
0e84bb9b-188c-433a-baf8-e6b1175fe19a
0fabc9a9-1e0f-4345-922f-251215649658
f6f813c7-fe4b-4384-96ad-b495db7eb69e
69cf5800-eaaf-40a3-870e-1bfbbcca1e17
7ca60b57-19d3-4659-b127-cbd625c730d6
242c8f53-56b9-459b-978d-6444a5951399
7532a47d-c756-4792-991a-5fe745c10908
640260e9-f350-4719-92de-7644aab8ee00
48dd112d-14a3-4b04-a088-bd79dbf6bc8f
a5177093-2b6f-45a3-8fe1-a3786d02783a
4872a0e1-2110-4445-8cd0-bc162b2f534e
de44e072-9ee6-4462-9407-908777233ecd
```

Additional RED evidence: with `FAKE_PROVIDER_DELIBERATE_CAP_VIOLATION=1`, the tracer failed on the expected DB-backed invariant: `sellerSprite DB active permit concurrency exceeded expected 1: 2`.

## Rollback

No production state is changed by this smoke. If the tracer fails, stop any remaining fake Agent process, remove the temporary test container, and rerun after the failing invariant is understood.
