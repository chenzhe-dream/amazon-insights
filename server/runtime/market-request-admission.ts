import type { MarketSemanticTaskName } from '../../shared/market-semantic-contracts';
import { assertMarketSemanticModelLimits } from '../skills/market-semantic-task-definitions';
import type { StructuredGenerationRequest } from './model-provider';
import { SkillRuntimeError, type ModelExecutionConfig } from './skill-runner';

export const MARKET_REQUEST_ESTIMATION_VERSION = 'market-openai-utf8-bound/v1';
export type MarketModelTransport = 'responses-strict' | 'relay-chat-json';

/** Conservative byte-based admission, not a tokenizer measurement or actual billed usage.
 * Includes serialized input, instructions/references, schema and the native transport
 * envelope, plus 512 units for framing. This policy targets the configured OpenAI
 * byte-level text transports; a different tokenizer/provider needs a new policy.
 * The native factory always disables the relay's duplicate schema prompt.
 */
export function estimateMarketRequestInput(request: Readonly<StructuredGenerationRequest<unknown>>, transport: MarketModelTransport): number {
  if (transport !== 'responses-strict' && transport !== 'relay-chat-json') throw new TypeError('Unsupported market model transport');
  const input = JSON.stringify(request.input);
  if (input === undefined) throw new TypeError('Market request input is not JSON');
  const body = transport === 'responses-strict'
    ? { model: request.model, instructions: request.instructions, input,
        max_output_tokens: request.maxOutputTokens, store: false, text: { format: request.responseFormat.format } }
    : { model: request.model, messages: [{ role: 'system', content: request.instructions }, { role: 'user', content: input }],
        response_format: { type: 'json_schema', json_schema: { name: request.responseFormat.format.name,
          strict: true, schema: request.responseFormat.format.schema } },
        reasoning_effort: 'low', verbosity: 'low', max_completion_tokens: request.maxOutputTokens };
  const estimate = Buffer.byteLength(JSON.stringify(body), 'utf8') + 512;
  if (!Number.isSafeInteger(estimate)) throw new TypeError('Market request input size is invalid');
  return estimate;
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
