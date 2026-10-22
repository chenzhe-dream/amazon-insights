# Candidate vision Messages route

Goal: restore real image analysis in candidate 33900/33901 using the user-authorized dedicated test key. Never change 31900/31901 or the supplier's Amazon选品 key group.

Evidence: OpenAI gpt-5.5, gpt-5.6 and gpt-5.6-sol accept requests but cannot observe images; Gemini and Claude test groups report no available accounts. The GLM group accepts the advertised Claude-compatible alias claude-sonnet-5 through /v1/messages and accurately describes the supplied image. This alias does not establish the underlying model's identity. Chat Completions is rejected on this route.

Design: add an explicit anthropic-messages adapter to the existing image request helper, with independent image-only base URL/key/model/protocol settings. Preserve the default OpenAI chat path. Read final text blocks only, require end_turn, allow only a single complete JSON fence, and retain unavailable-vision rejection. Use 2048 output tokens because 600 was consumed by the upstream reasoning block before a final answer. A live same-image control subsequently proved that a UK URL input returned provider error 1210 while inline bytes succeeded. Add opt-in base64 input for Messages: only HTTPS m.media-amazon.com/images/I/ JPEGs, no redirects or credentials, 20-second source deadline and 5 MiB streaming cap. Keep the original image URL as saved evidence identity. URL remains the default.

Scope and authorization: the user already requested repairing alternate vision routes and explicitly dedicated the existing 测试 key to 33900. No new provider account/key, production change, or supplier communication is included.

- [x] Add failing adapter/configuration/isolation tests; run the red test.
- [x] Implement image helper and collector configuration, document optional environment values; run request, queue, candidate and cache regressions plus type checking.
- [x] Run four-market live samples through the new helper, inspect image facts and JSON outputs.
- [x] Build and switch only the idle, identity-verified 33900/33901 candidate. Keep the test key in the proven group.
- [x] Run fresh real image requests for all 135 available images and normal image repair jobs; preserve missing UK galleries and distinguish fresh evidence from old results.
- [x] Verify saved outputs, report/UI readiness, request ledger, candidate fingerprint, and formal PID/commit/hash observations. Supply acceptance evidence only for actually passed checks; record the independent formal Web restart instead of claiming the strict unchanged-process check passed.

Validation before candidate switch: 60 image regression tests pass; TypeScript check passes. US/UK/DE live samples passed first attempt; CA returned HTTP 502 once and passed one bounded retry. This establishes route usability, not full gallery or provider reliability acceptance.


Live publication finding: same-image reanalysis with fewer classification tags was rejected by generic array-length coverage checks. Added two failing PostgreSQL regressions, then limited the exception to nonempty classification tags on usable same-URL notes. Blank/unavailable remarks, missing tags, URL mismatch and lost metadata still reject. All 32 display/retention integration tests and TypeScript pass. Later normal descendant jobs successfully published the US/DE results after the candidate switch; no source output was rewritten manually.

First full business pass: 20 image jobs / 135 physical image attempts, 116 fresh valid results and 19 failures across 13 ASINs. Stored old usable notes are not counted as fresh success. Preserve this first-pass evidence. After the input-mode fix, retry failed ASINs through normal jobs, at most three rounds, and audit final saved outputs and browser coverage. Four original UK ASINs without verified galleries remain explicit gaps.

Final result: 17 normal retry jobs across two rounds; 135/135 available static images have fresh valid results and matching current display outputs (US 55, UK 26, DE 33, CA 21). First-pass 135 plus retry 122 governed image operations; a source download failure does not dispatch a model request. Dedicated key remains valid with USD 601.37693805 balance. All eight old text reports and original R11 image outputs are unchanged. Browser counts verified, with DE's two additional video placeholders excluded from the static denominator. Candidate runtime remains cb5bf6ba / 9f168099, PIDs 387964 and 364488, idle. Formal Web independently changed PID and documentation-only commit label at 16:23 while its application source hash stayed unchanged; the strict protected-PID check correctly failed, no production action or rollback was performed. Full evidence and remaining data limits are recorded in docs/verification/2026-10-22-four-market-vision-routing-r13.md.
