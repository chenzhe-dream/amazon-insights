import assert from 'node:assert/strict';
import test from 'node:test';
import {projectShapeDraft,restoreShapeDraftItems,shapeDraftStorageKey} from '../../app/lib/market-shape-draft-browser';

test('capacity shrink preserves hidden ASIN edits and new ASINs default included',()=>{
  const items=[{asin:'B000000001',included:false,label:'Floor'},{asin:'B000000002',included:true,label:'Desk'}];
  assert.deepEqual(projectShapeDraft(['B000000001'],items),{selectedAsins:[],assignments:{B000000001:'Floor'}});
  assert.deepEqual(projectShapeDraft(['B000000001','B000000002','B000000003'],items),{selectedAsins:['B000000002','B000000003'],assignments:{B000000001:'Floor',B000000002:'Desk'}});
});

test('draft local key isolates actor, marketplace and canonical category but not capacity or run',()=>{
  const scope={organizationId:'org',researchId:'study',marketplace:'US',nodeIdPath:'1:2:3',currency:'USD',fromMonth:'2026-07',toMonth:'2026-08'} as const;
  const same=shapeDraftStorageKey(scope,'user-a');
  assert.equal(same,shapeDraftStorageKey({...scope,researchId:'new-study'},'user-a'));
  assert.notEqual(same,shapeDraftStorageKey(scope,'user-b'));
  assert.notEqual(same,shapeDraftStorageKey({...scope,nodeIdPath:'1:2:4'},'user-a'));
});

test('restoring a saved version keeps draft edits for ASINs outside its historic pool',()=>{
  const previous=[{asin:'B000000001',included:true,label:'New'},{asin:'B000000002',included:true,label:'Later'},{asin:'B000000003',included:false,label:'Hidden'}];
  assert.deepEqual(restoreShapeDraftItems(previous,['B000000001','B000000004'],['B000000004'],[{asin:'B000000001',label:'Historic'},{asin:'B000000004',label:'Added'}]),[
    {asin:'B000000001',included:false,label:'Historic'},
    {asin:'B000000002',included:true,label:'Later'},
    {asin:'B000000003',included:false,label:'Hidden'},
    {asin:'B000000004',included:true,label:'Added'},
  ]);
});
