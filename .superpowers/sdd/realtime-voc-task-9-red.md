# Realtime Manual Alexa VOC Task 9 RED

Command:

```powershell
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-publication.test.ts
```

Observed result before production implementation:

- Exit: `1`
- Tests: `1` failed at module load, `0` passed
- Expected failure: `ERR_MODULE_NOT_FOUND` for
  `server/data/manual-alexa-voc-projection-store`
- The failure proves the Task 9 server-only projection/publication runtime did
  not exist before implementation.

No production file was created or changed before this RED run.

## Agent Service lifecycle RED

Command:

```powershell
npx tsx --conditions=react-server --test tests/agent/agent-service-shutdown.test.ts
```

Observed result before lifecycle wiring:

- Exit: `1`
- Tests: `2` passed, `1` failed
- Expected failure: the enabled publication worker was never started, so the
  test timed out waiting for `generation-1.json`.
- Duration: `6320.5372ms`
