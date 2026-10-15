import test from 'node:test';
import assert from 'node:assert/strict';
import {detectW2Label,W4_FAMILIES,SCENE_PATTERNS} from '../../shared/market-keyword-semantic-rules';
import {parseNumericRange,isLowReviewRange,isHighReviewRange} from '../../shared/market-numeric-range';
import {formatPriceBand} from '../../app/market-shape-reference/rules';
import {fixedShapeLabels} from '../../app/market-shape-reference/shape-catalog';
import {assertShapeHistoryScope} from '../../app/lib/market-shape-history-scope';
for(const word of ['apple corer','pineapple peeler','happy birthday banner','application brush','miniature painting','marcus toy'])test(`No substring inference: ${word}`,()=>assert.equal(W4_FAMILIES.some(r=>r.pattern.test(word)),false));
for(const word of ['storage 10-20 liter','table 13-19 cm','cable 3-5 m','box 10 x 20 inches','USD 10-20','battery 18-24 volt'])test(`Numeric specification is not age: ${word}`,()=>assert.equal(detectW2Label(word,'age'),null));
for(const [word,label] of [['toy ages 3-5','儿童'],['bike ages 13-17','青少年'],['helmet ages 18-65','成人'],['scooter for seniors','老人'],['Spielzeug für Kinder','儿童']])test(`Audience context: ${word}`,()=>assert.equal(detectW2Label(word,'age'),label));
for(const [word,label] of [['dimmbar','调光'],['fernbedienung','智能控制'],['foldable chair','便携/折叠'],['stackable boxes','堆叠'],['app controlled fan','智能控制']])test(`Shared feature: ${word}`,()=>assert.equal(W4_FAMILIES.find(r=>r.pattern.test(word))?.label,label));
for(const word of ['Wohnzimmer','Schlafzimmer','kitchen','cuisine','cocina','cucina'])test(`Shared scene: ${word}`,()=>assert.ok(SCENE_PATTERNS.find(r=>r.pattern.test(word))));
for(const value of ['500-1000','1,000以上','500+','>1000'])test(`High review boundary: ${value}`,()=>{assert.equal(isLowReviewRange(value),false);assert.equal(isHighReviewRange(value),true);});
for(const value of ['<50','100-200','200–300','＜300'])test(`Low review boundary: ${value}`,()=>{assert.equal(isLowReviewRange(value),true);assert.equal(isHighReviewRange(value),false);});
for(const value of ['unknown','500-100','special 100 box'])test(`Invalid range stays unknown: ${value}`,()=>assert.equal(parseNumericRange(value),null));
for(const currency of ['EUR','GBP','JPY','CAD','INR','MXN'])test(`Native currency: ${currency}`,()=>assert.equal(formatPriceBand(25,currency),`${currency} 20-30`));
test('Fixed category only applies to verified site and node, never name substring',()=>{assert.equal(fixedShapeLabels('Kick Scooters','999').length,0);assert.equal(fixedShapeLabels('Kick Scooters','13280971','DE').length,0);assert.equal(fixedShapeLabels('Mobility Scooters','13280971').length,0);assert.equal(fixedShapeLabels('Kick Scooters','13280971').length,3);});
test('History rejects every scope mismatch',()=>{const scope={organizationId:'a',researchId:'b',marketplace:'US',currency:'USD',nodeIdPath:'1:2',fromMonth:'2026-08',toMonth:'2026-09'} as const;assert.doesNotThrow(()=>assertShapeHistoryScope(scope,scope));for(const key of Object.keys(scope))assert.throws(()=>assertShapeHistoryScope(scope,{...scope,[key]:'different'}));});

import {overviewContentOpportunity} from '../../server/domain/market-research/overview-content-opportunity';
test('Content conclusion uses complete disjoint numeric evidence and marks a missing bucket',()=>{
 const rows=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'].map((label,i)=>({label,products:[10,20,10,60][i],unitsShare:[20,20,10,50][i]})) as any;
 const full=overviewContentOpportunity(rows);assert.equal(full.missing.length,0);assert.match(full.conclusion,/A\+覆盖率 30.0%/);assert.match(full.conclusion,/视频覆盖率 20.0%/);assert.match(full.opportunity,/内容补位/);
 const partial=overviewContentOpportunity(rows.slice(1));assert.ok(partial.missing.length>0);assert.match(partial.conclusion,/待验证/);
});
