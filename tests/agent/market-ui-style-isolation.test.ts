import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import postcss from 'postcss';

test('supplied presentation styles cannot target legacy pages outside the four-module root',async()=>{
 const css=postcss.parse(await readFile(new URL('../../app/market-ui-reference.css',import.meta.url),'utf8'));
 let checked=0;
 css.walkRules(rule=>{
  if(rule.parent?.type==='atrule' && /keyframes$/i.test(rule.parent.name))return;
  for(const selector of rule.selectors){assert.match(selector,/^\.market-ui-reference(?:\b|\s|[.#:[>+~])/);checked++;}
 });
 css.walkAtRules(rule=>{assert.notEqual(rule.name,'import','global stylesheet imports must not escape isolation');if(/keyframes$/i.test(rule.name))assert.match(rule.params,/^market-ui-/);});
 assert.ok(checked>100,'reference stylesheet must be present');
});
