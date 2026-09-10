# Normalization queue collision regression

## Scope and evidence

Production was inspected read-only. No job status, input, revision, credential, or generated publication was changed.

For the user-selected three-ASIN run, two durable revisions existed and the third encrypted input existed without a model audit. The normalization stage remained queued with two retryable failed attempts; attempt 1 had recovery disposition `recover/pending`, while attempt 2 had `recover/unstarted`. Separately, positioning exhausted its upstream model retries; that is not the third input's normalization error.

Pure reconstruction of cumulative publication from the real durable revisions failed with `VOC records must be unique and follow target ASIN order`. The record at index 1 violated the trusted project order. Both revision capture timestamps matched the run cutoff, eliminating a cutoff hypothesis. This ordering fix is covered by the parallel runtime task.

## Retry collision

Normalization allows earlier logical cycles to finish publication after new inputs append a stage job. Retrying the predecessor used `current.attemptNumber + 1`; the appended job already occupied that unique `(stage_id, attempt_number)` pair. The failed claim transaction left the same candidate eligible and blocked progress.

Both repositories now allocate the next free stage ordinal under their existing transaction/locking protocol. The new maximum is `nextAttempt + oldMaxAttempts - oldAttempt - 1`: exactly one remaining execution attempt is consumed, regardless of unrelated ordinals. Logical cycle and retry-cycle start remain unchanged. The separately queued job is not rewritten.

## Tests

Command:

```powershell
node --import tsx --conditions=react-server --test --test-name-pattern='predecessor skips occupied' tests/agent/voc-queue-safety.test.ts
```

- RED: SQLite failed/expired predecessor tests both failed with the expected `UNIQUE constraint failed: job_attempts.stage_id, job_attempts.attempt_number`. PostgreSQL was initially blocked by the other task's in-progress forward migration, not counted as a bug reproduction.
- GREEN after the migration was stabilized: 4 tests passed, 0 failed, covering SQLite and PostgreSQL.
- Assertions cover unchanged queued sibling, preserved cycle identity, exact remaining budget, stale lease rejection, exhausted retries stopping without allocating unlimited jobs, and the independent queued job still being claimable.

Full combined regression and independent review are recorded separately. Production recovery still requires activation of verified code; a passing local test is not a live repair claim.
