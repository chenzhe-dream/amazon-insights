import assert from 'node:assert/strict';
import test from 'node:test';
import { loadVocPositioningRuntimeConfig } from '../../server/config';
import { loadMarketModelRuntimeConfig } from '../../server/runtime/market-model-config';
import { buildMarketModelRuntimeIdentityVersions } from '../../server/runtime/market-model-runtime';
import { marketSemanticTaskDefinitions, marketOverviewLegacySkill } from '../../server/skills/market-semantic-task-definitions';

const env = {
  OPENAI_API_KEY: 'synthetic-secret', OPENAI_BASE_URL: 'https://synthetic.invalid/v1',
  AGENT_VOC_TRANSPORT: 'relay-chat-json', AGENT_VOC_MODEL: 'gpt-5.6',
  AGENT_VOC_ESTIMATED_INPUT_TOKENS: '10000', AGENT_VOC_MAX_OUTPUT_TOKENS: '4000', AGENT_VOC_TIMEOUT_MS: '90000',
  AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: '1', AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: '2',
  AGENT_VOC_CALL_MAX_TOKENS: '100000', AGENT_VOC_CALL_MAX_COST_MICROS: '1000000',
  AGENT_VOC_RUN_MAX_TOKENS: '100000', AGENT_VOC_RUN_MAX_COST_MICROS: '1000000',
  AGENT_VOC_DAILY_MAX_TOKENS: '100000', AGENT_VOC_DAILY_MAX_COST_MICROS: '1000000', AGENT_VOC_WORKER_OWNER_ID: 'synthetic-worker',
};

test('market transport defaults to the existing configuration without changing VOC', () => {
  assert.deepEqual(loadMarketModelRuntimeConfig(env), loadVocPositioningRuntimeConfig(env));
  assert.deepEqual(loadMarketModelRuntimeConfig({ ...env, AGENT_MARKET_MODEL_TRANSPORT: 'relay-chat-json' }), loadVocPositioningRuntimeConfig(env));
});

test('native default remains native and an explicit relay switch requires a validated endpoint', () => {
  const nativeEnv = { ...env, AGENT_VOC_TRANSPORT: 'responses-strict' };
  assert.deepEqual(loadMarketModelRuntimeConfig(nativeEnv), loadVocPositioningRuntimeConfig(nativeEnv));
  const relay = loadMarketModelRuntimeConfig({ ...nativeEnv, AGENT_MARKET_MODEL_TRANSPORT: 'relay-chat-json' });
  assert.equal(relay.baseUrl, env.OPENAI_BASE_URL);
  assert.equal(relay.transport, 'relay-chat-json');
  assert.throws(() => loadMarketModelRuntimeConfig({ ...nativeEnv, OPENAI_BASE_URL: 'https://user:secret@synthetic.invalid/v1', AGENT_MARKET_MODEL_TRANSPORT: 'relay-chat-json' }), error => {
    assert.doesNotMatch((error as Error).message, /user|secret|synthetic\.invalid/); return true;
  });
});

test('explicit market Responses override preserves the validated endpoint, credentials and limits', () => {
  const configured = { ...env, AGENT_MARKET_MODEL_TRANSPORT: 'responses-strict' };
  const voc = loadVocPositioningRuntimeConfig(configured), market = loadMarketModelRuntimeConfig(configured);
  assert.equal(voc.transport, 'relay-chat-json');
  assert.equal(market.transport, 'responses-strict');
  for (const key of ['baseUrl', 'apiKey', 'model', 'budgetLimits', 'worker'] as const) assert.deepEqual(market[key], voc[key]);
  assert.notEqual(market.providerName, voc.providerName);
  assert.doesNotMatch(market.providerName, /synthetic-secret|synthetic\.invalid/);
  assert.ok(Object.isFrozen(market));
});

test('invalid market overrides fail without exposing configuration values', () => {
  for (const override of ['', 'unknown-secret', 'responses-strict\nsecret']) {
    assert.throws(() => loadMarketModelRuntimeConfig({ ...env, AGENT_MARKET_MODEL_TRANSPORT: override }), error => {
      assert.equal((error as Error).message, 'Market model transport configuration is invalid'); return true;
    });
  }
});

test('market transport is included in all native runtime identities and not prompt identity', () => {
  const manifests = new Map(marketSemanticTaskDefinitions.map(task => [task.id, { ...task.skill, contentHash: 'synthetic-content' }]));
  const legacyManifest = { ...marketOverviewLegacySkill, contentHash: 'synthetic-legacy' };
  const previous = buildMarketModelRuntimeIdentityVersions(loadMarketModelRuntimeConfig(env), manifests, legacyManifest);
  const next = buildMarketModelRuntimeIdentityVersions(loadMarketModelRuntimeConfig({ ...env, AGENT_MARKET_MODEL_TRANSPORT: 'responses-strict' }), manifests, legacyManifest);
  for (const key of ['configurationVersion', 'shapeExplanationConfigurationVersion', 'overviewSynthesisConfigurationVersion'] as const) assert.notEqual(next[key], previous[key]);
  for (const key of ['promptVersion', 'shapeExplanationPromptVersion', 'overviewSynthesisPromptVersion'] as const) assert.equal(next[key], previous[key]);
  assert.doesNotMatch(JSON.stringify(next), /synthetic-secret|synthetic\.invalid/);
});

test('market shape and theme timeouts are opt-in, bounded and enter configuration identity', () => {
  const manifests = new Map(marketSemanticTaskDefinitions.map(task => [task.id, { ...task.skill, contentHash: 'synthetic-content' }]));
  const legacy = { ...marketOverviewLegacySkill, contentHash: 'synthetic-legacy' };
  const before = buildMarketModelRuntimeIdentityVersions(loadMarketModelRuntimeConfig(env), manifests, legacy);
  const configured = { ...env, AGENT_MARKET_SHAPE_TIMEOUT_MS: '120000', AGENT_MARKET_THEME_TIMEOUT_MS: '110000' };
  const after = buildMarketModelRuntimeIdentityVersions(loadMarketModelRuntimeConfig(configured), manifests, legacy);
  assert.equal(before.models['market-product-shape-suggestion'].timeoutMs, 60000);
  assert.equal(before.models['market-customer-theme-mapping'].timeoutMs, 60000);
  assert.equal(after.models['market-product-shape-suggestion'].timeoutMs, 120000);
  assert.equal(after.models['market-customer-theme-mapping'].timeoutMs, 110000);
  assert.deepEqual(after.models['market-keyword-semantics'], before.models['market-keyword-semantics']);
  assert.deepEqual(after.models['market-overview-explanation'], before.models['market-overview-explanation']);
  assert.equal(loadVocPositioningRuntimeConfig(configured).model.timeoutMs, 90000);
  assert.notEqual(after.configurationVersion, before.configurationVersion);
  for (const value of ['120001', '0', '-1', '1.5', 'NaN', 'secret', '']) {
    assert.throws(() => loadMarketModelRuntimeConfig({ ...env, AGENT_MARKET_THEME_TIMEOUT_MS: value }), /Market task timeout configuration is invalid/);
  }
});
