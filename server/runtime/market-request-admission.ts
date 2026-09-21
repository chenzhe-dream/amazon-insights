import type { MarketSemanticTaskName } from '../../shared/market-semantic-contracts';
import { assertMarketSemanticModelLimits } from '../skills/market-semantic-task-definitions';
import type { StructuredGenerationRequest } from './model-provider';
import { SkillRuntimeError, type ModelExecutionConfig } from './skill-runner';
import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import { createRelayJsonSchemaInstruction } from './openai-provider';

export const MARKET_REQUEST_ESTIMATION_VERSION = 'market-openai-o200k-allowlist-bounded-margin20-framing512-byte-fallback-explicit-schema-low-outputcap-fence/v4';
export type MarketModelTransport = 'responses-strict' | 'relay-chat-json';
let tokenizer: Tiktoken | undefined;
const o200kModels: ReadonlySet<string> = new Set([
  'gpt-5.6', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-chat-latest',
  'gpt-4o', 'gpt-4o-mini', 'chatgpt-4o-latest', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'gpt-4.5-preview', 'o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini', 'o4-mini',
]);

/** Local admission estimate, never provider-reported or billed usage.
 * Known OpenAI families use the pinned o200k encoding over the complete serialized
 * envelope, with 20% estimation margin and 512 framing tokens. Unknown model names
 * retain the original byte upper bound. Do not infer encodings for arbitrary aliases.
 * Supplier text that resembles special tokens is counted as ordinary text.
 */
export function measureMarketRequestInput(request: Readonly<StructuredGenerationRequest<unknown>>, transport: MarketModelTransport) {
  if (transport !== 'responses-strict' && transport !== 'relay-chat-json') throw new TypeError('Unsupported market model transport');
  const input = JSON.stringify(request.input);
  if (input === undefined) throw new TypeError('Market request input is not JSON');
  const schemaInstruction = createRelayJsonSchemaInstruction(request.responseFormat.format);
  const body = transport === 'responses-strict'
    ? { model: request.model, instructions: `${request.instructions}\n\n${schemaInstruction}`, input,
        max_output_tokens: request.maxOutputTokens, store: false, reasoning: { effort: 'low' }, text: { format: request.responseFormat.format, verbosity: 'low' } }
    : { model: request.model, messages: [{ role: 'system', content: request.instructions }, { role: 'system', content: schemaInstruction }, { role: 'user', content: input }],
        response_format: { type: 'json_schema', json_schema: { name: request.responseFormat.format.name,
          strict: true, schema: request.responseFormat.format.schema } },
        reasoning_effort: 'low', verbosity: 'low', max_completion_tokens: request.maxOutputTokens };
  const serialized = JSON.stringify(body), bytes = Buffer.byteLength(serialized, 'utf8');
  const knownEncoding = o200kModels.has(request.model.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
  // Pure JS BPE has quadratic behavior on very long individual pieces. Preserve
  // all evidence but fall back before encoding pathological supplier text/schema;
  // do not let planning block worker heartbeats. Digits are split by o200k itself.
  const expensivePiece = /[\p{L}\p{M}]{256}|[^\p{L}\p{N}]{256}/u.test(serialized);
  const useTokenizer = knownEncoding && bytes <= 131_072 && !expensivePiece;
  const tokens = useTokenizer ? (tokenizer ??= new Tiktoken(o200kBase)).encode(serialized, [], []).length : null;
  const estimate = (tokens === null ? bytes : Math.ceil(tokens * 1.2)) + 512;
  if (!Number.isSafeInteger(estimate)) throw new TypeError('Market request input size is invalid');
  return Object.freeze({ estimatedInputTokens: estimate, serializedBytes: bytes, encodedTokens: tokens,
    encoding: useTokenizer ? 'o200k_base' as const : 'utf8-bound' as const, framingTokens: 512,
    marginTokens: tokens === null ? 0 : Math.ceil(tokens * 1.2) - tokens });
}

export function estimateMarketRequestInput(request: Readonly<StructuredGenerationRequest<unknown>>, transport: MarketModelTransport): number {
  return measureMarketRequestInput(request, transport).estimatedInputTokens;
}

export function createMarketRequestAdmission(task: MarketSemanticTaskName, model: ModelExecutionConfig, transport: MarketModelTransport) {
  assertMarketSemanticModelLimits(task, model);
  if (transport !== 'responses-strict' && transport !== 'relay-chat-json') throw new TypeError('Unsupported market model transport');
  // The caller cannot change admission by mutating the resolved configuration later.
  const limits = { name: model.name, input: model.estimatedInputTokens, output: model.maxOutputTokens, timeout: model.timeoutMs };
  return (request: Readonly<StructuredGenerationRequest<unknown>>): void => {
    if (request.model !== limits.name || request.maxOutputTokens !== limits.output || request.timeoutMs !== limits.timeout ||
      estimateMarketRequestInput(request, transport) > limits.input) {
      throw new SkillRuntimeError('CONFIGURATION_ERROR', 'Market semantic request exceeds its configured input, output or timeout admission');
    }
  };
}
