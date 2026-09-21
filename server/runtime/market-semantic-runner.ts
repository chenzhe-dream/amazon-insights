import { randomUUID } from 'node:crypto';
import type { MarketSemanticTaskName } from '../../shared/market-semantic-contracts';
import type { ModelBudgetLimits } from '../db/model-budget-repository';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresModelBudgetStore } from '../db/postgres/model-budget-store';
import { PostgresMarketModelBudgetStore } from '../db/postgres/market-model-budget-store';
import { PostgresConcurrencyControlStore } from '../db/postgres/concurrency-control-store';
import { PostgresResourceGovernor } from '../db/concurrency-control-repository';
import type { SkillRegistry } from '../skills/registry';
import { MarketModelBudgetCoordinator } from './market-model-budget-coordinator';
import { ModelBudgetCoordinator, StaticModelBudgetLimitProvider } from './model-budget-coordinator';
import { createMarketRequestAdmission, type MarketModelTransport } from './market-request-admission';
import { OpenAIProvider, type OpenAIProviderOptions } from './openai-provider';
import { SkillRunner, type ModelExecutionConfig, type ModelValidationLogger } from './skill-runner';

export interface MarketSemanticRunnerConfiguration {
  task: MarketSemanticTaskName;
  /** Safe schema diagnostics only; never raw provider output. */
  validationLogger?: ModelValidationLogger;
  model: ModelExecutionConfig;
  providerName: string;
  transport: MarketModelTransport;
  /** Server-resolved organization policy, shared by both legacy and native ledgers. */
  limits: ModelBudgetLimits;
  openAI: Omit<OpenAIProviderOptions, 'transport' | 'schemaPromptMode' | 'deferOutputValidation' | 'resourceGovernor' | 'responsesLowReasoning' | 'enforceOutputTokenLimit' | 'allowSingleJsonFence'>;
}

/** One physical retry loop and one organization ledger; never a separate market quota. */
export function createMarketSemanticSkillRunner(context: PostgresQueryContext, registry: SkillRegistry, configuration: MarketSemanticRunnerConfiguration) {
  const admission = createMarketRequestAdmission(configuration.task, configuration.model, configuration.transport);
  const limitProvider = new StaticModelBudgetLimitProvider(configuration.limits);
  return new SkillRunner({
    registry,
    providerName: configuration.providerName,
    provider: new OpenAIProvider({ ...configuration.openAI, transport: configuration.transport,
      schemaPromptMode: 'prompt-and-native', allowSingleJsonFence: true, deferOutputValidation: true, responsesLowReasoning: true, enforceOutputTokenLimit: true,
      resourceGovernor: new PostgresResourceGovernor(new PostgresConcurrencyControlStore(context, { permitId: randomUUID }), `market:${randomUUID()}`) }),
    budgetCoordinator: new ModelBudgetCoordinator({ repository: new PostgresModelBudgetStore(context), limitProvider }),
    marketBudgetCoordinator: new MarketModelBudgetCoordinator({ repository: new PostgresMarketModelBudgetStore(context),
      limitProvider: { getLimits: () => limitProvider.getLimits() } }),
    validateGenerationRequest: admission,
    ...(configuration.validationLogger ? { validationLogger: configuration.validationLogger } : {}),
  });
}
