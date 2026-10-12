import assert from 'node:assert/strict';
import test from 'node:test';
import {shapePollingDelay} from '../../app/lib/market-shape-polling';
test('permanent read failures stop and transient failures retain bounded backoff',()=>{
 for(const status of [401,403,404])assert.equal(shapePollingDelay(1,{status}),null);
 for(const error of [{status:503},new Error('network')])assert.deepEqual([1,2,3,4,5].map(n=>shapePollingDelay(n,error)),[4000,8000,16000,30000,null]);
});
