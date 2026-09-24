# Generated analysis data in the formal service

The 15 `app/*-data.ts` and `app/listing-image-remarks.ts` modules are committed baseline seeds. A formal sync must never rewrite them in the code worktree. It reads and writes their mutable copies under `AGENT_DATA_ROOT/generated-app-data/`. The first formal access copies a missing seed once; an existing external copy is never overwritten by a new deployment. The report shown to a project remains the validated PostgreSQL current display version, not these shared cache files.

`listingImageRemarksMeta.pendingReason: "analysis_incomplete"` describes the most recent generator attempt. It is not the status of every project in the file. Check the current display version, its per-ASIN image outcomes, and its image remark overlay before declaring a published report incomplete. A failed attempt must retain its real gap and must not replace an earlier complete version.

## Release and cleanup

1. Preserve the current dirty generated files and database with a dated backup and hashes. Do not overwrite the formal worktree while another release is using it.
2. Deploy code from a clean checkout with `AGENT_FORMAL_WORKTREE_ROOT`, `AGENT_DATA_ROOT`, and `AGENT_RUNTIME_ROOT` set. Ensure both runtime roots are absolute and outside the checkout. On first access, the external cache seeds from the checkout's baseline. To preserve newer dirty cache records, copy the verified dirty files into `AGENT_DATA_ROOT/generated-app-data/` before starting the new code; never promote those files as the current report.
3. Compare the current PostgreSQL version IDs, image galleries, remarks, and per-ASIN gaps before and after deployment. Run a scoped sync and verify the external file changes while `git status` in the code checkout remains clean. Verify direct project and favorite entry points in a browser after restart.
4. Only after that verification, restore the 15 tracked modules in the old formal checkout to their committed baseline if that checkout is no longer serving requests. Keep a backup until its separate retention policy is confirmed. Do not bulk commit the dirty files or remove the committed seeds while client and legacy server imports still use them as fallback data.

The external cache stores text, including image URLs and remarks, not image bytes. The report and its current version pointer remain in PostgreSQL. Removing the committed baseline modules requires a separate migration of their remaining static imports and a clean-checkout regression run.
