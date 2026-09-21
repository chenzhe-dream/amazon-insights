import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createMarketRequestAdmission, estimateMarketRequestInput, measureMarketRequestInput, type MarketModelTransport } from '../../server/runtime/market-request-admission';
import { createStructuredResponseFormat } from '../../server/runtime/structured-response-format';
import type { StructuredGenerationRequest } from '../../server/runtime/model-provider';
import type { ModelExecutionConfig } from '../../server/runtime/skill-runner';

const schema = z.object({ summary: z.string() }).strict();
const request: StructuredGenerationRequest<unknown> = { model: 'synthetic-text', instructions: 'Use the supplied evidence.', input: { text: '灯具 "shelf"\n𠮷😀' },
  outputSchema: schema, responseFormat: createStructuredResponseFormat(schema, 'TestOutput@1'), maxOutputTokens: 4000, timeoutMs: 60000 };
const model: ModelExecutionConfig = { name: request.model, estimatedInputTokens: 12000, maxOutputTokens: 4000, timeoutMs: 60000,
  pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } };

test('UTF-8 request admission counts input, instructions, schema, escaped envelope and framing for both native transports', () => {
  for (const transport of ['responses-strict', 'relay-chat-json'] as MarketModelTransport[]) {
    const size = estimateMarketRequestInput(request, transport);
    assert.ok(size > Buffer.byteLength(JSON.stringify(request.input)) + Buffer.byteLength(request.instructions) + Buffer.byteLength(JSON.stringify(request.responseFormat.format)) + 512);
    assert.equal(estimateMarketRequestInput({ ...request, instructions: request.instructions + '灯' }, transport), size + 3);
    const exact = { ...model, estimatedInputTokens: size };
    assert.doesNotThrow(() => createMarketRequestAdmission('market-overview-explanation', exact, transport)(request));
    assert.throws(() => createMarketRequestAdmission('market-overview-explanation', { ...exact, estimatedInputTokens: size - 1 }, transport)(request));
    const admission = createMarketRequestAdmission('market-overview-explanation', exact, transport);
    exact.estimatedInputTokens = 12000;
    assert.throws(() => admission({ ...request, input: { text: '灯'.repeat(4000) } }));
    assert.throws(() => admission({ ...request, instructions: request.instructions + '\nFORMAT REPAIR: ' + 'long diagnostics'.repeat(20) }));
    for (const delta of [{ model: 'different' }, { maxOutputTokens: 8000 }, { timeoutMs: 60001 }]) assert.throws(() => admission({ ...request, ...delta }));
  }
});

test('unsupported transport and invalid task/model limits fail closed', () => {
  assert.throws(() => createMarketRequestAdmission('market-overview-explanation', model, 'unknown' as MarketModelTransport));
  assert.throws(() => createMarketRequestAdmission('market-product-shape-suggestion', model, 'responses-strict'));
  assert.throws(() => estimateMarketRequestInput({ ...request, input: undefined }, 'responses-strict'));
  assert.throws(() => createMarketRequestAdmission('market-overview-explanation', { ...model, estimatedInputTokens: NaN }, 'responses-strict'));
});

test('recognized model admits ordinary structured evidence by tokens rather than bytes without relaxing its budget', () => {
  const realModelRequest = { ...request, model: 'gpt-5.6', input: { title: '中性笔 retractable gel pen', evidence: 'source evidence for product classification. '.repeat(250) } };
  for (const transport of ['responses-strict', 'relay-chat-json'] as MarketModelTransport[]) {
    assert.ok(Buffer.byteLength(JSON.stringify(realModelRequest.input)) > 8000);
    const counted = estimateMarketRequestInput(realModelRequest, transport);
    assert.ok(counted < 7000, `bounded evidence must fit with headroom, got ${counted}`);
    assert.doesNotThrow(() => createMarketRequestAdmission('market-overview-explanation', { ...model, name: realModelRequest.model, estimatedInputTokens: 8000 }, transport)(realModelRequest));
    const oversized = { ...realModelRequest, instructions: '必须核验每一条证据。'.repeat(8000) };
    assert.throws(() => createMarketRequestAdmission('market-overview-explanation', { ...model, name: realModelRequest.model, estimatedInputTokens: 8000 }, transport)(oversized));
  }
});

test('count includes schema and repairs, uses explicit encodings, and treats special-token text as untrusted ordinary input',()=>{
  for(const transport of ['responses-strict','relay-chat-json'] as MarketModelTransport[]){
    const known={...request,model:'gpt-5.6',input:{text:'<|endoftext|> <|fim_suffix|> 𠮷😀'}};
    const measured=measureMarketRequestInput(known,transport);
    assert.equal(measured.encoding,'o200k_base');assert.ok(measured.encodedTokens!>0);
    assert.equal(measured.estimatedInputTokens,Math.ceil(measured.encodedTokens!*1.2)+512);
    const largeSchema=createStructuredResponseFormat(z.object({summary:z.string().describe('Validate each evidence reference against its source. '.repeat(100))}),'LargeSchema');
    assert.ok(estimateMarketRequestInput({...known,responseFormat:largeSchema},transport)>measured.estimatedInputTokens);
    for(const name of ['custom-alias','gpt-50','gpt-5-custom-alias','gpt-5.not-a-model','o3-custom-alias']){
      assert.equal(measureMarketRequestInput({...known,model:name},transport).encoding,'utf8-bound');
    }
    assert.equal(measureMarketRequestInput({...known,input:{text:'x'.repeat(1_048_577)}},transport).encoding,'utf8-bound');
    const longPiece=measureMarketRequestInput({...known,input:{text:'x'.repeat(8192)}},transport);
    assert.equal(longPiece.encoding,'utf8-bound','long unbroken pieces must avoid quadratic synchronous BPE work');
    assert.equal(longPiece.estimatedInputTokens,longPiece.serializedBytes+512);
  }
});
