import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {collectPluginShapeCategoryPool} from '../../server/services/plugin-shape-category-pool';
import {projectPluginThemeSample} from '../../server/services/theme-plugin-sample';
import {canonicalJsonSha256 as hash} from '../../server/runtime/model-request-accounting';

test('saved fallback images retain canonical parsing and raw evidence paths',()=>{
 const asins=Array.from({length:150},(_,i)=>`B${String(i).padStart(9,'0')}`),url='https://m.media-amazon.com/images/I/a.jpg';
 const scope={organizationId:randomUUID(),researchId:randomUUID(),nodeIdPath:'34',marketplace:'US' as const,currency:'USD' as const,fromMonth:'2026-09',toMonth:'2026-09'};
 const pool=collectPluginShapeCategoryPool({scope,poolSize:100,now:new Date('2026-10-19T04:00:00Z'),source:{snapshotId:'plugin-source:'+'a'.repeat(64),jobId:randomUUID(),node:'34',marketplace:'US',collectedAt:'2026-10-19T03:00:00Z',asins,membershipProvider:'amazon-page',basic:Object.fromEntries(asins.map(asin=>[asin,{asin,title:'Lamp',currency:'USD'}]))}});
 for(const main_image of [[url],JSON.stringify([url]),' '+JSON.stringify([url]),' '+url+' ']){
  const result=projectPluginThemeSample({scope,evidence:pool.evidence,sourceRef:'market-source:'+hash(pool.evidence),inputSnapshotId:'market-input:'+'b'.repeat(64),asin:asins[0],product:pool.products[0],imageSource:{ref:'market-source:'+'c'.repeat(64),snapshotId:'market-input:'+'d'.repeat(64),payload:{data:{main_image}}}});
  assert.equal(result.imageUrl.value,url);
  assert.deepEqual(result.imageUrl.evidence?.path,Array.isArray(main_image)?['data','main_image',0]:['data','main_image']);
 }
});
