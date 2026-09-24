import assert from 'node:assert/strict';
import test from 'node:test';
import {buildManualShapeCatalog} from '../../app/lib/market-shape-manual-draft';

test('manual shape names become a saved catalog only after collection', () => {
  const first=buildManualShapeCatalog([],['B000000002','B000000001'],{
    B000000001:' 层架式 ',B000000002:'弧形灯臂式',
  });
  assert.deepEqual(first.labels.map(label=>label.label),['层架式','弧形灯臂式']);
  assert.deepEqual(first.assignments,[
    {asin:'B000000002',labelId:first.labels[1].labelId},
    {asin:'B000000001',labelId:first.labels[0].labelId},
  ]);
  assert.match(first.labels[0].definition,/人工标注.*未单独记录判断依据/);
  const second=buildManualShapeCatalog(first.labels,['B000000001','B000000002'],{
    B000000001:'层架式',B000000002:'',
  });
  assert.equal(second.assignments.length,1);
  assert.equal(second.assignments[0].labelId,first.labels[0].labelId);
  assert.deepEqual(second.labels,first.labels);
});

test('manual catalog rejects a shape name or label count outside the saved contract', () => {
  assert.throws(()=>buildManualShapeCatalog([],['B000000001'],{B000000001:'x'.repeat(61)}),/60/);
  const many=Object.fromEntries(Array.from({length:33},(_,i)=>[`B${String(i).padStart(9,'0')}`,`形态${i}`]));
  assert.throws(()=>buildManualShapeCatalog([],Object.keys(many),many),/32/);
});
