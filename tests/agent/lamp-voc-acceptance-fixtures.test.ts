import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ALEXA_VOC_DIMENSIONS, parseAlexaVocReport } from '../../scripts/lib/parse-alexa-voc-report.mjs';

const asins = ['B0CP8Q2JCS', 'B0F43M9KWW', 'B0BDD936ZC'];
for (const asin of asins) test(`synthetic lamp VOC ${asin} binds only its ASIN and contains all seven dimensions`, () => {
  const text = readFileSync(new URL(`../../docs/testing/2026-09-10-lamp-voc/${asin}.txt`, import.meta.url), 'utf8');
  assert.match(text, /模拟测试数据，非真实买家反馈，非 Alexa 原始回复/);
  for (const other of asins.filter(value => value !== asin)) assert.ok(!text.includes(other));
  const parsed = parseAlexaVocReport(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.asin, asin);
  assert.deepEqual(parsed.missing, []);
  assert.equal(parsed.rating, null);
  assert.equal(parsed.reviewCount, null);
  for (const { key } of ALEXA_VOC_DIMENSIONS) {
    assert.ok(parsed.sections[key].length >= 2, `${key} needs at least two identifiable test points`);
    for (const record of parsed.sections[key]) assert.match(record.text, /模拟/);
  }
});
