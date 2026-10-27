import assert from 'node:assert/strict';
import test from 'node:test';
import {buildReviewAnalysisFromRecords} from '../../scripts/lib/review-analysis-aggregate.mjs';
import {localizeReviewBlocks} from '../../scripts/lib/review-label-zh.mjs';

const analyze=(reviews,market='DE')=>buildReviewAnalysisFromRecords('B09GY72DX2',market,reviews,'2026-10-26',{family:'generic'});
const rows=(record,key)=>record.blocks.find(b=>b.key===key)?.rows??[];
const review=(content,star=5,title='')=>({content,star,title});

test('German installation and workmanship become evidence-backed themes with full sample denominator',()=>{
 const result=analyze([
  review('Hält gut, ist gut anzubringen',5,'Gutes Produkt'),
  review('Gute Verarbeitung! Befestigungklemmen wären 2-3 auf Vorrat gut.',4),
  review('Super Qualität und sorgt für viel Freude. Anbringen war leicht und es ist sehr variabel.'),
  review('Für Kinder geeignet. Die Kinder verbessern ihre Koordination. Der Aufbau des Sets ist schnell und unkompliziert.'),
  review('Lieferung schnell sieht hochwertig aus.....wird aber erst im Frühjahr aufgebaut'),
 ]);
 const installation=rows(result,'positives').find(r=>r.label==='安装便捷');
 assert.equal(installation?.numerator,3);
 assert.equal(installation?.denominator,5);
 assert.equal(installation?.sharePct,60);
 assert.match(installation.reason,/gut anzubringen/);
 assert.ok(rows(result,'consumerProfile').some(r=>r.label==='儿童使用'));
 assert.ok(rows(result,'unmet').some(r=>r.label==='备用配件需求'),'four-star requests must not disappear');
 assert.deepEqual(localizeReviewBlocks(result.blocks),result.blocks,'original evidence survives collector localization');
});

test('Super only supports general approval, not six invented dimensions',()=>{
 const result=analyze([review('Super',5,'!!')]);
 assert.deepEqual(rows(result,'positives'),[]);
 assert.match(result.statusMessage,/笼统好评.*Super/);
 for(const key of ['consumerProfile','scenarios','unmet','negatives','motives'])assert.deepEqual(rows(result,key),[]);
 assert.equal(result.sampledReviews,1);
});

test('German negation and speculative use cannot become positive claims even at five stars',()=>{
 for(const text of ['Nicht stabil. Keine gute Qualität. Nicht leicht anzubringen.', 'Super schlecht', 'Wird erst im Frühjahr aufgebaut', 'Nicht für Kinder geeignet.']){
  const result=analyze([review(text)]);
  assert.deepEqual(rows(result,'positives'),[],text);
  assert.deepEqual(rows(result,'consumerProfile'),[],text);
 }
});

test('German negation is clause-local and preserves a separate positive observation',()=>{
 const result=analyze([review('Nicht stabil, aber leicht anzubringen.')]);
 assert.deepEqual(rows(result,'positives').map(r=>r.label),['安装便捷']);
 assert.ok(rows(result,'negatives').some(r=>r.label==='结构不稳'));
});

test('bilingual same-theme review counts once and German matching stays in DE scope',()=>{
 const result=analyze([review('Easy assembly. Leicht anzubringen.')]);
 assert.equal(rows(result,'positives').find(r=>r.label==='安装便捷')?.numerator,1);
 assert.deepEqual(rows(analyze([review('Super')],'CA'),'positives'),[]);
});
