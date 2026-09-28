import test from 'node:test';
import assert from 'node:assert/strict';
import {readKeywordRun,keywordReadRetryDelay} from '../../app/lib/market-keyword-browser';
import {keywordRunId} from './helpers/market-keyword-page-fixture';

test('keyword state reads retry only temporary failures with bounded backoff',async()=>{
 const previous=globalThis.fetch;
 try{
  for(const status of [401,403,404,409,422,408,429,500,502,503]){
   globalThis.fetch=async()=>Response.json({error:{message:'temporary or terminal failure'}},{status});
   let error:unknown;try{await readKeywordRun(keywordRunId);}catch(e){error=e;}
   const transient=[408,429,500,502,503].includes(status);
   assert.equal(keywordReadRetryDelay(error,1),transient?2000:null,`status ${status}`);
   assert.equal(keywordReadRetryDelay(error,6),null,'never retry indefinitely');
  }
  assert.deepEqual([1,2,3,4,5,6].map(n=>keywordReadRetryDelay(new TypeError('Failed to fetch'),n)),[2000,4000,8000,16000,30000,null]);
  assert.equal(keywordReadRetryDelay(new Error('facts identity mismatch'),1),null);
  assert.equal(keywordReadRetryDelay(new DOMException('Aborted','AbortError'),1),null);
  globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError('terminated'));}}),{status:200});
  let interrupted:unknown;try{await readKeywordRun(keywordRunId);}catch(e){interrupted=e;}
  assert.equal(keywordReadRetryDelay(interrupted,1),2000,'response-body network interruption must recover');
  globalThis.fetch=async()=>new Response('invalid json',{status:200});
  let malformed:unknown;try{await readKeywordRun(keywordRunId);}catch(e){malformed=e;}
  assert.equal(keywordReadRetryDelay(malformed,1),null,'malformed response must not loop');
 }finally{globalThis.fetch=previous;}
});
