import type { MarketSemanticInput, MarketSemanticOutput } from '../../shared/market-semantic-contracts';
import { marketSemanticContracts, marketSemanticOutputContract, marketSemanticExecutionDefinition, assertMarketSemanticModelLimits } from '../skills/market-semantic-task-definitions';
import type { SkillRunner, PreparedSkillExecution } from './skill-runner';
import type { MarketSemanticRunnerConfiguration } from './market-semantic-runner';
import { estimateMarketRequestInput } from './market-request-admission';
import {marketSemanticWire} from './market-semantic-wire';

/** Reserve some repair headroom without claiming arbitrary repairs always fit.
 * Every physical repair still passes the normal exact-request admission gate. */
export const MARKET_BATCH_REPAIR_HEADROOM = 512;
// A1 selects immutable fact IDs rather than returning extracted free text. Keep
// a smaller planning allowance; every real repair still passes exact admission.
// This is not extra provider budget and is not a guarantee that a repair fits.
export const MARKET_OVERVIEW_REPAIR_HEADROOM = 256;
export function createMarketSemanticBatchMeter(runner: Pick<SkillRunner, 'prepare' | 'assertPreparedContractIdentity'>,
  configuration: MarketSemanticRunnerConfiguration, signal?: AbortSignal) {
  assertMarketSemanticModelLimits(configuration.task, configuration.model);
  const task = configuration.task;
  const model = Object.freeze({ ...configuration.model, pricing: Object.freeze({ ...configuration.model.pricing }) });
  const transport = configuration.transport;
  const templates=new Map<string,PreparedSkillExecution<unknown,MarketSemanticOutput>>();
  return async (candidate: MarketSemanticInput): Promise<boolean> => {
    signal?.throwIfAborted();
    if (candidate.task !== task) throw new TypeError('Market batch meter task is inconsistent');
    const contracts = marketSemanticContracts[task], input=contracts.input.parse(candidate),wire=marketSemanticWire(input),inputSchema=wire.inputSchema??contracts.input;
    const definition=marketSemanticExecutionDefinition(input),output=marketSemanticOutputContract(input),key=wire.encoding+':'+wire.variant+':'+definition.skill.version+':'+definition.outputSchema+':'+(input.task==='market-overview-explanation'&&input.analysisBrief?'analysis':'legacy');
    // prepare loads instructions, references and strict wire schema but never
    // reserves budget or invokes a provider. Its native batch ID is not a legacy run.
    let template=templates.get(key);template ??= await runner.prepare<unknown, MarketSemanticOutput>({ skill: definition.skill,
      inputContract: { name: definition.inputSchema, schema: inputSchema, allowedFields: Object.keys(inputSchema.shape) },
      outputContract: { name: definition.outputSchema, schema: output.output, schemaDefinitions: wire.responseSchema?wire.responseSchemaDefinitions:output.schemaDefinitions, responseSchema:wire.responseSchema },
      input:wire.input, snapshotIds: [input.batchId], model, signal });
    templates.set(key,template);
    signal?.throwIfAborted(); runner.assertPreparedContractIdentity(template);
    const estimate = estimateMarketRequestInput({ model: model.name, instructions: template.instructions, input:wire.input,
      outputSchema: template.outputContract.schema, responseFormat: template.responseFormat,
      maxOutputTokens: model.maxOutputTokens, timeoutMs: model.timeoutMs }, transport);
    return estimate + (task==='market-overview-explanation'?MARKET_OVERVIEW_REPAIR_HEADROOM:MARKET_BATCH_REPAIR_HEADROOM) <= model.estimatedInputTokens;
  };
}
