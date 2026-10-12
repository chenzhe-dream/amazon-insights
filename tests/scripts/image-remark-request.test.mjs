import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_IMAGE_REMARK_MODEL,
  DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS,
  fetchImageRemarkWithTimeout,
  imageRemarkEndpoint,
  imageRemarkModel,
  imageRemarkRequestTimeoutMs,
  readImageRemarkProviderPayload,
  readImageRemarkFailureDiagnostic,
  requestImageRemark,
} from "../../scripts/lib/image-remark-request.mjs";
import { IMAGE_REMARK_TIMEOUT_MS } from "../../scripts/lib/image-remark-policy.mjs";

test("automatic image remark requests use the shared 120 second deadline and ignore environment shortening", () => {
  assert.equal(DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS, IMAGE_REMARK_TIMEOUT_MS);
  assert.equal(imageRemarkRequestTimeoutMs({}), DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS);
  assert.equal(
    imageRemarkRequestTimeoutMs({ OPENAI_IMAGE_REQUEST_TIMEOUT_MS: "25000" }),
    DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS,
  );
  assert.equal(imageRemarkRequestTimeoutMs({ OPENAI_IMAGE_REQUEST_TIMEOUT_MS: "invalid" }), DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS);
});

test("image remark requests abort when the timeout elapses", async () => {
  const pendingFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });

  await assert.rejects(
    fetchImageRemarkWithTimeout(pendingFetch, "https://example.test/image", {}, 1),
    /timed out/i,
  );
});

test("image remark endpoint uses the official default and one relay v1 segment", () => {
  assert.equal(imageRemarkEndpoint({}), "https://api.openai.com/v1/chat/completions");
  assert.equal(
    imageRemarkEndpoint({ OPENAI_BASE_URL: "https://relay.example.test/" }),
    "https://relay.example.test/v1/chat/completions",
  );
  assert.equal(
    imageRemarkEndpoint({ OPENAI_BASE_URL: "https://relay.example.test/gateway/v1/v1/" }),
    "https://relay.example.test/gateway/v1/chat/completions",
  );
  assert.equal(
    imageRemarkEndpoint({ OPENAI_BASE_URL: "https://relay.example.test/v1//v1" }),
    "https://relay.example.test/v1/chat/completions",
  );
});

test("image remark endpoint rejects unsafe bases without echoing them", () => {
  for (const value of [
    "ftp://relay.example.test/v1",
    "https://user:secret@relay.example.test/v1",
    "https://relay.example.test/v1#secret-fragment",
    "not a url",
  ]) {
    assert.throws(
      () => imageRemarkEndpoint({ OPENAI_BASE_URL: value }),
      error => error instanceof Error && !error.message.includes(value) && !/secret/i.test(error.message),
    );
  }
});

test("image remark model precedence is vision, VOC, then fallback", () => {
  assert.equal(imageRemarkModel({ OPENAI_VISION_MODEL: " vision-model ", AGENT_VOC_MODEL: "voc-model" }), "vision-model");
  assert.equal(imageRemarkModel({ OPENAI_VISION_MODEL: " ", AGENT_VOC_MODEL: " voc-model " }), "voc-model");
  assert.equal(imageRemarkModel({}), DEFAULT_IMAGE_REMARK_MODEL);
});

test("provider failures expose only closed request diagnostics", async () => {
  const secretPattern = /provider-secret|body-secret|image-secret|model-secret|prompt-secret|key-secret/i;
  const cases = [
    {
      expected: { stage: "http-response", httpStatus: 502, errorClass: "http" },
      fetchImpl: async () => new Response("provider-secret body-secret", { status: 502 }),
    },
    {
      expected: { stage: "fetch", httpStatus: null, errorClass: "network" },
      fetchImpl: async () => {
        throw new Error("provider-secret network failure");
      },
    },
    {
      expected: { stage: "response-json", httpStatus: 200, errorClass: "invalid-json" },
      fetchImpl: async () => new Response("provider-secret invalid json", { status: 200 }),
    },
    {
      expected: { stage: "response-output", httpStatus: 200, errorClass: "invalid-output" },
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: "provider-secret invalid output" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    },
  ];

  for (const { expected, fetchImpl } of cases) {
    let capturedError;
    await assert.rejects(
      requestImageRemark({
        fetchImpl,
        endpoint: "https://provider-secret.example/v1/chat/completions",
        apiKey: "key-secret",
        signal: new AbortController().signal,
        model: "model-secret",
        prompt: "prompt-secret",
        imageUrl: "https://image-secret.example/image.jpg",
      }),
      error => {
        capturedError = error;
        return error instanceof Error;
      },
    );
    const diagnostic = readImageRemarkFailureDiagnostic(capturedError);
    assert.deepEqual(diagnostic, expected);
    assert.deepEqual(Object.keys(diagnostic).sort(), ["errorClass", "httpStatus", "stage"]);
    assert.doesNotMatch(JSON.stringify({ message: capturedError.message, diagnostic }), secretPattern);
  }

  assert.equal(readImageRemarkFailureDiagnostic(new Error("provider-secret")), null);
});

test("provider payload reader uses the same closed diagnostics", async () => {
  for (const [response, expected] of [
    [new Response("provider secret body", { status: 502 }), { stage: "http-response", httpStatus: 502, errorClass: "http" }],
    [new Response("not json", { status: 200 }), { stage: "response-json", httpStatus: 200, errorClass: "invalid-json" }],
  ]) {
    let capturedError;
    await assert.rejects(readImageRemarkProviderPayload(response), error => {
      capturedError = error;
      return error instanceof Error && error.message === "Image analysis provider request failed";
    });
    assert.deepEqual(readImageRemarkFailureDiagnostic(capturedError), expected);
  }
});

import { runImageRemarkQueue, shouldQueueImageRemarkSlot } from '../../scripts/lib/image-remark-queue.mjs';
import { imageRemarkOutcome } from '../../scripts/lib/image-remark-outcome.mjs';

test('provider failure diagnostics survive queue and progress without secrets', async () => {
  for (const status of [429,401,403]) {
    let progress;
    const results = await runImageRemarkQueue([1], () => requestImageRemark({ endpoint:'https://example.test', apiKey:'secret', fetchImpl:async()=>({ok:false,status}) }), { jobId:'diagnostic-job', onSettled:value=>{progress=value;} });
    const diagnostic={stage:'http-response',httpStatus:status,errorClass:'http'};
    assert.deepEqual(results[0].diagnostic, diagnostic);
    assert.deepEqual(progress.diagnostic, diagnostic);
  }
  assert.deepEqual(imageRemarkOutcome('connector-failed',{diagnostic:{stage:'fetch',errorClass:'network',httpStatus:null,apiKey:'secret',url:'secret'}}).diagnostic,{stage:'fetch',httpStatus:null,errorClass:'network'});
});

test('authentication failures do not automatically retry in a later job', () => {
  assert.equal(shouldQueueImageRemarkSlot({outcome:{status:'connector-failed',attemptJobId:'old',diagnostic:{stage:'http-response',httpStatus:401,errorClass:'http'}},jobId:'new'}),false);
});

import { createImageRemarkCandidate } from '../../scripts/lib/image-remark-job-candidate.mjs';
test('actual request failure retains closed diagnostics in a serialized candidate', async()=>{
  for (const fixture of [
    {fetchImpl:async()=>{throw Error('secret');},expected:{stage:'fetch',httpStatus:null,errorClass:'network'}},
    {fetchImpl:async()=>({ok:true,status:200,json:async()=>{throw Error('secret');}}),expected:{stage:'response-json',httpStatus:200,errorClass:'invalid-json'}},
    {fetchImpl:async()=>({ok:true,status:200,json:async()=>({choices:[]})}),expected:{stage:'response-output',httpStatus:200,errorClass:'invalid-output'}},
  ]) {
    const [outcome]=await runImageRemarkQueue([1],()=>requestImageRemark({endpoint:'https://example.test',apiKey:'secret',fetchImpl:fixture.fetchImpl}),{jobId:'job'});
    const asin='B000000001';
    const candidate=createImageRemarkCandidate({jobId:'job',listingContentHash:'a'.repeat(64),asins:[asin],listingByAsin:{[asin]:{galleryImages:['https://images.test/a']}},remarksByAsin:{[asin]:[null]},outcomesByAsin:{[asin]:[{...outcome,diagnostic:{...outcome.diagnostic,body:'secret'}}]}});
    assert.deepEqual(JSON.parse(JSON.stringify(candidate)).outcomesByAsin[asin][0].diagnostic,fixture.expected);
    assert.equal(JSON.stringify(candidate).includes('secret'),false);
  }
});
test('queue never downgrades fatal source hash and scope failures',async()=>{
  for (const message of ['source hash mismatch', 'scope mismatch', 'unexpected collector write failure']) {
    await assert.rejects(runImageRemarkQueue([1],async()=>{throw Error(message);}),error=>error.message===message);
  }
});
