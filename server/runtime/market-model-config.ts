import { loadVocPositioningRuntimeConfig, type VocPositioningRuntimeConfig } from '../config';
import { sha256Hex } from './model-request-accounting';
import type { MarketSemanticTaskName } from '../../shared/market-semantic-contracts';

export type MarketModelRuntimeConfig = VocPositioningRuntimeConfig & Readonly<{
  marketTaskTimeouts?: Readonly<Partial<Record<MarketSemanticTaskName, number>>>;
}>;

export function marketTaskTimeout(base: MarketModelRuntimeConfig, task: { id: MarketSemanticTaskName; budget: { timeoutMs: number } }): number {
  const override = base.marketTaskTimeouts?.[task.id];
  const defaultLimit = task.id === 'market-product-shape-suggestion' || task.id === 'market-customer-theme-mapping' ? 60000 : task.budget.timeoutMs;
  if (override !== undefined && (!Number.isInteger(override) || override < 1000 || override > task.budget.timeoutMs)) {
    throw new Error('Market task timeout configuration is invalid');
  }
  return override ?? Math.min(base.model.timeoutMs, defaultLimit);
}

/** Market-only protocol selection. Keep the validated credential/endpoint pair together. */
export function loadMarketModelRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MarketModelRuntimeConfig {
  const base = loadVocPositioningRuntimeConfig(env);
  const timeouts: Partial<Record<MarketSemanticTaskName, number>> = {};
  for (const [key, task] of [['AGENT_MARKET_SHAPE_TIMEOUT_MS', 'market-product-shape-suggestion'], ['AGENT_MARKET_THEME_TIMEOUT_MS', 'market-customer-theme-mapping']] as const) {
    const value = env[key];
    if (value === undefined) continue;
    if (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 120000) throw new Error('Market task timeout configuration is invalid');
    timeouts[task] = Number(value);
  }
  const configured: MarketModelRuntimeConfig = Object.keys(timeouts).length
    ? Object.freeze({ ...base, marketTaskTimeouts: Object.freeze(timeouts) }) : base;
  const transport = env.AGENT_MARKET_MODEL_TRANSPORT;
  if (transport === undefined || transport === base.transport) return configured;
  if (transport !== 'responses-strict' && transport !== 'relay-chat-json') {
    throw new Error('Market model transport configuration is invalid');
  }
  // A relay endpoint must pass the existing URL validator when switching from the default native endpoint.
  const baseUrl = transport === 'relay-chat-json' && base.baseUrl === null
    ? loadVocPositioningRuntimeConfig({ ...env, AGENT_VOC_TRANSPORT: transport }).baseUrl
    : base.baseUrl;
  return Object.freeze({
    ...configured, transport, baseUrl,
    providerName: `openai:${transport}${baseUrl === null ? '' : `:${sha256Hex(baseUrl)}`}`,
  });
}
