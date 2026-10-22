import assert from 'node:assert/strict';
import test from 'node:test';
import * as request from '../../scripts/lib/image-remark-request.mjs';

const note={remark:'红白靶面配蓝色支架，旁边排列玩具斧和红蓝飞镖。',image_types:['产品展示'],confidence:'high'};
const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,0xff,0xd9]);
const args={protocol:'anthropic-messages',inputMode:'base64',endpoint:'https://vision.example/v1/messages',apiKey:'secret',imageUrl:'https://m.media-amazon.com/images/I/test.jpg',model:'alias',prompt:'Observe the image'};
const answer=()=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(note)}]}));

test('inline mode is explicit, Messages-only, and defaults to URL',()=>{
  assert.equal(request.imageRemarkInputMode({}),'url');
  assert.equal(request.imageRemarkInputMode({AGENT_IMAGE_REMARK_PROTOCOL:'anthropic-messages',AGENT_IMAGE_REMARK_INPUT_MODE:'base64'}),'base64');
  assert.throws(()=>request.imageRemarkInputMode({AGENT_IMAGE_REMARK_INPUT_MODE:'base64'}));
  assert.throws(()=>request.imageRemarkInputMode({AGENT_IMAGE_REMARK_INPUT_MODE:'secret-invalid'}),e=>!e.message.includes('secret-invalid'));
});

test('inline image fetch has no credentials, disallows redirects, and sends verified bytes to the provider',async()=>{
  const calls=[];const controller=new AbortController();
  const result=await request.requestImageRemark({...args,signal:controller.signal,fetchImpl:async(url,init)=>{
    calls.push({url,init});return url===args.imageUrl?new Response(jpeg,{headers:{'content-type':'image/jpeg','content-length':String(jpeg.length)}}):answer();
  }});
  assert.deepEqual(result,note);assert.equal(calls.length,2);
  assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers?.['x-api-key'],undefined);assert.equal(calls[0].init.headers?.Authorization,undefined);
  assert(calls[0].init.signal instanceof AbortSignal);
  const body=JSON.parse(calls[1].init.body);
  assert.deepEqual(body.messages[0].content[0],{type:'image',source:{type:'base64',media_type:'image/jpeg',data:jpeg.toString('base64')}});
  assert.equal(calls[1].init.headers['x-api-key'],'secret');
});

test('inline source rejects untrusted origins and paths before any network request',async()=>{
  for(const url of ['http://m.media-amazon.com/images/I/a.jpg','https://127.0.0.1/a.jpg','https://m.media-amazon.com.evil.test/images/I/a.jpg','https://secret@m.media-amazon.com/images/I/a.jpg','https://m.media-amazon.com:444/images/I/a.jpg','https://m.media-amazon.com/other/a.jpg']){
    let calls=0;
    await assert.rejects(request.requestImageRemark({...args,imageUrl:url,fetchImpl:async()=>{calls++;return answer();}}),e=>request.readImageRemarkFailureDiagnostic(e)?.stage==='image-source'&&!e.message.includes(url));
    assert.equal(calls,0);
  }
});

test('source HTTP errors, non-image data, excessive declared or streamed bytes never reach the model',async()=>{
  for(const response of [new Response('secret',{status:503}),new Response('<html>error</html>',{headers:{'content-type':'image/jpeg'}}),new Response(jpeg,{headers:{'content-type':'text/html'}}),new Response(jpeg,{headers:{'content-type':'image/jpeg','content-length':String(5*1024*1024+1)}}),new Response(new Uint8Array(5*1024*1024+1),{headers:{'content-type':'image/jpeg'}})]){
    let calls=0;
    await assert.rejects(request.requestImageRemark({...args,fetchImpl:async()=>{calls++;return response;}}),e=>request.readImageRemarkFailureDiagnostic(e)?.stage==='image-source'&&!e.message.includes('secret'));
    assert.equal(calls,1);
  }
});

test('source cancellation stays sanitized and cannot dispatch a model request',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(request.requestImageRemark({...args,signal:controller.signal,fetchImpl:async(_url,init)=>{calls++;init.signal.throwIfAborted();return answer();}}),e=>request.readImageRemarkFailureDiagnostic(e)?.stage==='image-source');
  assert(calls<=1);
});

test('malformed Messages content produces a typed invalid-output diagnostic',async()=>{
  await assert.rejects(request.requestImageRemark({...args,inputMode:'url',fetchImpl:async()=>new Response(JSON.stringify({stop_reason:'end_turn',content:{filter:'not callable'}}))}),e=>request.readImageRemarkFailureDiagnostic(e)?.errorClass==='invalid-output');
});
