# Candidate vision Messages route

Goal: restore real image analysis in candidate 33900/33901 using the user-authorized dedicated test key. Never change 31900/31901 or the supplier's Amazon选品 key group.

Evidence: OpenAI gpt-5.5, gpt-5.6 and gpt-5.6-sol accept requests but cannot observe images; Gemini and Claude test groups report no available accounts. The GLM group accepts the advertised Claude-compatible alias claude-sonnet-5 through /v1/messages and accurately describes the supplied image. This alias does not establish the underlying model's identity. Chat Completions is rejected on this route.

Design: add an explicit anthropic-messages adapter to the existing image request helper, with independent image-only base URL/key/model/protocol settings. Preserve the default OpenAI chat path. Send existing image URLs using the Messages image source contract; no local image downloader is needed. Read final text blocks only, require end_turn, allow only a single complete JSON fence, and retain unavailable-vision rejection. Use 2048 output tokens because 600 was consumed by the upstream reasoning block before a final answer.

Scope and authorization: the user already requested repairing alternate vision routes and explicitly dedicated the existing 测试 key to 33900. No new provider account/key, production change, or supplier communication is included.

- [x] Add failing adapter/configuration/isolation tests; run the red test.
- [x] Implement image helper and collector configuration, document optional environment values; run request, queue, candidate and cache regressions plus type checking.
- [x] Run four-market live samples through the new helper, inspect image facts and JSON outputs.
- [ ] Build and switch only the idle, identity-verified 33900/33901 candidate. Keep the test key in the proven group.
- [ ] Run fresh real image requests for all 135 available images and normal image repair jobs; preserve missing UK galleries and distinguish fresh evidence from old results.
- [ ] Verify saved outputs, report/UI readiness, request ledger, candidate fingerprint, and unchanged formal PIDs/commit/hash. Supply acceptance evidence only for actually passed checks.

Validation before candidate switch: 60 image regression tests pass; TypeScript check passes. US/UK/DE live samples passed first attempt; CA returned HTTP 502 once and passed one bounded retry. This establishes route usability, not full gallery or provider reliability acceptance.

