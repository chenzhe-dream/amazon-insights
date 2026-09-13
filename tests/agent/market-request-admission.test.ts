import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createMarketRequestAdmission, estimateMarketRequestInput, type MarketModelTransport } from '../../server/runtime/market-request-admission';
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
