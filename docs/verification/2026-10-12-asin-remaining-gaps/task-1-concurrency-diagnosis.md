# Follow-up: image concurrent candidate failure under broad suite load

Status: diagnosis complete; no production fix required within image scope. The Windows lock identity prerequisite remained fatal throughout.

## Observations

Root combined suite: 229/230 passed, original two-job candidate regression failed with `integrity-failed` and generic safe storage/integrity message.

Isolated command `node --test tests/scripts/image-remark-concurrent-candidate.test.mjs`: 2/2 passed before instrumentation (two-job 1003ms; target-only 747ms). After fixture-only instrumentation, same command passed 2/2 (two-job 1024ms; target-only 716ms).

Added closed fixture instrumentation by rewriting only the copied collector inside this test's scratch directory. Exact error message `Unable to establish Windows interprocess lock owner identity` emits `TEST_IMAGE_INTEGRITY_CAUSE windows-lock-owner-identity-unavailable`; all other messages emit `other-integrity-error`. No error stack, arbitrary body, URL or secret is printed. Production collector is unchanged and still uses its original generic fatal handler.

Then ran eight independent copies of that narrow command concurrently to reproduce the load condition. All eight failed the two-job regression and passed the target-only regression. Every failure emitted exactly:

```
TEST_IMAGE_INTEGRITY_CAUSE windows-lock-owner-identity-unavailable
IMAGE_REMARK_OUTCOME {"status":"integrity-failed"}
```

Two-job elapsed times were 2565-2731ms. This establishes the exact thrown prerequisite error under concurrent process load; it does not show a cross-job candidate data race. The Windows currentProcessIdentity function obtains process identity via PowerShell/CIM subprocess with a 2000ms timeout and throws this exact error when identity cannot be established.

## Action

Keep lock/source/hash/scope/fatal guards unchanged. Do not lengthen timeout, accept unavailable process identity, or downgrade integrity failure to connector outcome. Final root suite should bound outer test-file concurrency (root chose 2), retaining the original test's internal Promise.all two-job concurrent writes and separate candidate verification.

Only follow-up changed file: `tests/scripts/image-remark-concurrent-candidate.test.mjs` gains fixture-only closed failure instrumentation. No production file changed for this investigation. Stress processes finished before root final suite; no further heavy tests are being launched by this worker.
