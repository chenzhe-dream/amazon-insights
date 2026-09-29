import assert from 'node:assert/strict';
import test from 'node:test';
import * as price from '../../scripts/build-sorftime-price-strategy.mjs';

test('price consumer separates malformed responses from valid unavailable price', () => {
  const asin = 'B0FN7XXJRM';
  for (const [detailRaw, priceRaw, operation] of [
    [{}, {data:[]}, 'product_detail'],
    [{data:{asin:'B000000000',price:10}}, {data:[]}, 'product_detail'],
    [{data:{asin,price:'invalid'}}, {data:[]}, 'product_detail'],
    [{data:{asin,price:10}}, {data:{unknown:'body-secret'}}, 'product_trend'],
    [{data:{asin,price:10}}, {data:['2026-08=bad']}, 'product_trend'],
  ]) {
    assert.throws(() => price.parsePriceStrategyResponse({asin, detailRaw, priceRaw}), error => {
      assert.equal(error.diagnostic?.causeCode, 'MCP_SCHEMA');
      assert.equal(error.diagnostic?.operation, operation);
      assert.doesNotMatch(error.message, /body-secret/);
      return true;
    });
  }
  assert.equal(price.parsePriceStrategyResponse({asin,detailRaw:{data:{asin,price:0}},priceRaw:{data:[]}}), null);
  assert.equal(price.parsePriceStrategyResponse({asin,detailRaw:{data:{asin,price:25}},priceRaw:{data:['2026-08=24']}}).currentPrice,25);
});
