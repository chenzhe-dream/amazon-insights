import assert from 'node:assert/strict';
import test from 'node:test';

test('runtime projections load and retain marketplace currency validation', async () => {
  const {MarketOverviewSynthesisTransportInputSchema} = await import('../../server/runtime/market-semantic-wire');
  const {MarketShapeExplanationCatalogSchema} = await import('../../shared/market-shape-explanation-contracts');
  const scope = {marketplace:'UK', currency:'GBP', nodeIdPath:'123', fromMonth:'2026-08', toMonth:'2026-08'};
  const transport = MarketOverviewSynthesisTransportInputSchema.shape.scope;
  assert.equal(transport.safeParse(scope).success, true);
  assert.equal(transport.safeParse({...scope, currency:'USD'}).success, false);
  assert.equal(transport.safeParse({...scope, researchId:'11111111-1111-4111-8111-111111111111'}).success, false);
  const extended = {...scope, researchId:'11111111-1111-4111-8111-111111111111', organizationId:'test-org', requestedAsins:[], eligibleAsins:[]};
  assert.equal(MarketShapeExplanationCatalogSchema.shape.scope.safeParse(extended).success, true);
  assert.equal(MarketShapeExplanationCatalogSchema.shape.scope.safeParse({...extended, currency:'USD'}).success, false);
  assert.equal(MarketShapeExplanationCatalogSchema.shape.scope.safeParse({...extended, fromMonth:'2026-09'}).success, false);
});
