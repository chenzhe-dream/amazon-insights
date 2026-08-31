# Realtime Manual Alexa VOC Task 8 RED Evidence

## Atomic service path

Command:

```powershell
npx tsx --conditions=react-server --test --test-name-pattern="SQLite creates run" tests/agent/manual-alexa-voc-run-atomicity.test.ts
```

Observed result: exit code 1, 0 pass, 1 fail.

Expected failure:

```text
TypeError: lifecycle.createRunWithVocSnapshot is not a function
```

This proves the new test reaches the intended missing atomic service API after its SQLite identity and Manual VOC fixtures are valid.

## Strict external cutoff ownership

Command:

```powershell
npx tsx --conditions=react-server --test --test-name-pattern="run creation owns its cutoff" tests/agent/contracts.test.ts
```

Observed result: exit code 1, 0 pass, 1 fail.

Expected failure:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
true !== false
```

The `true` value is `CreateRunRequestSchema.safeParse(...)` accepting a request that injects `dataCutoffAt`; Task 8 requires strict rejection.

## Combined RED note

The plan's combined RED command was also started. Existing lifecycle tests remained green, while all five new atomicity cases failed because the atomic method is absent. PostgreSQL barrier cases intentionally hold transactions until the missing run operation crosses their gates, so the process was interrupted after recording the focused deterministic failures above. The complete file is required to terminate and pass in GREEN.
