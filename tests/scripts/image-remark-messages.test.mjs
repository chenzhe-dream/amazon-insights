import assert from 'node:assert/strict';
import test from 'node:test';
import * as imageRequest from '../../scripts/lib/image-remark-request.mjs';

const note = {remark:'蓝色支架配红白靶面，玩具斧与红蓝飞镖分布在两种摆放形态的靶架周围。',image_types:['产品展示','结构展示'],confidence:'high'};
const env = {AGENT_IMAGE_REMARK_PROTOCOL:'anthropic-messages',AGENT_IMAGE_REMARK_BASE_URL:'https://vision.example/v1',AGENT_IMAGE_REMARK_API_KEY:'vision-secret',AGENT_IMAGE_REMARK_MODEL:'vision-alias',OPENAI_BASE_URL:'https://text.example/v1',OPENAI_API_KEY:'text-secret',OPENAI_VISION_MODEL:'old-model'};

test('independent image route cannot change text credentials or inherit them for a custom route',()=>{
  assert.equal(imageRequest.imageRemarkEndpoint(env),'https://vision.example/v1/messages');
  assert.equal(imageRequest.imageRemarkModel(env),'vision-alias');
  assert.equal(imageRequest.imageRemarkApiKey(env),'vision-secret');
  assert.equal(imageRequest.imageRemarkApiKey({...env,AGENT_IMAGE_REMARK_API_KEY:''}),'');
  assert.equal(imageRequest.imageRemarkApiKey({OPENAI_API_KEY:'legacy'}),'legacy');
  assert.equal(imageRequest.imageRemarkApiKey({OPENAI_API_KEY:'legacy',AGENT_IMAGE_REMARK_BASE_URL:'https://another.example'}),'');
  assert.equal(env.OPENAI_API_KEY,'text-secret');
});

test('image protocol is explicit and rejects unsupported values before dispatch',()=>{
  assert.equal(imageRequest.imageRemarkProtocol({}),'openai-chat');
  assert.equal(imageRequest.imageRemarkProtocol(env),'anthropic-messages');
  assert.throws(()=>imageRequest.imageRemarkProtocol({AGENT_IMAGE_REMARK_PROTOCOL:'unknown-secret'}),e=>!e.message.includes('unknown-secret'));
});

test('messages adapter sends image URL and reads only final text, including a single JSON fence',async()=>{
  let captured;
  const result=await imageRequest.requestImageRemark({protocol:'anthropic-messages',endpoint:'https://vision.example/v1/messages',apiKey:'vision-secret',model:'vision-alias',prompt:'Only observed facts',imageUrl:'https://m.media-amazon.com/images/I/test.jpg',fetchImpl:async(url,init)=>{
    captured={url,...init,body:JSON.parse(init.body)};
    return new Response(JSON.stringify({type:'message',stop_reason:'end_turn',content:[{type:'thinking',thinking:'private reasoning must not be parsed'},{type:'text',text:'```json\n'+JSON.stringify(note)+'\n```'}]}));
  }});
  assert.deepEqual(result,note);
  assert.equal(captured.headers['x-api-key'],'vision-secret');
  assert.equal(captured.headers.Authorization,undefined);
  assert.equal(captured.headers['anthropic-version'],'2023-06-01');
  assert.equal(captured.body.max_tokens,2048);
  assert.equal(captured.body.response_format,undefined);
  assert.deepEqual(captured.body.messages[0].content,[{type:'image',source:{type:'url',url:'https://m.media-amazon.com/images/I/test.jpg'}},{type:'text',text:'Only observed facts'}]);
});

test('messages adapter rejects truncation, reasoning-only output, wrappers and unavailable vision',async()=>{
  for(const payload of [
    {stop_reason:'max_tokens',content:[{type:'text',text:JSON.stringify(note)}]},
    {stop_reason:'end_turn',content:[{type:'thinking',thinking:JSON.stringify(note)}]},
    {stop_reason:'end_turn',content:{text:JSON.stringify(note)}},
    {stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({content:note})}]},
    {stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({...note,remark:'图片转写服务不可用，无法识别画面内容'})}]},
    {stop_reason:'end_turn',content:[{type:'text',text:'Explanation\n```json\n'+JSON.stringify(note)+'\n```'}]},
  ]) await assert.rejects(imageRequest.requestImageRemark({protocol:'anthropic-messages',endpoint:'https://vision.example/v1/messages',apiKey:'secret',fetchImpl:async()=>new Response(JSON.stringify(payload))}),e=>imageRequest.readImageRemarkFailureDiagnostic(e)?.errorClass==='invalid-output');
});

test('unsupported request protocols cannot dispatch a provider request',async()=>{
  let called=false;
  await assert.rejects(imageRequest.requestImageRemark({protocol:'unknown-secret',fetchImpl:async()=>{called=true;}}));
  assert.equal(called,false);
});

test('legacy chat requests retain their original headers, envelope and strict JSON parser',async()=>{
  let body,headers;
  const result=await imageRequest.requestImageRemark({endpoint:'https://text.example/v1/chat/completions',apiKey:'legacy-secret',model:'gpt-5.5',prompt:'prompt',imageUrl:'https://images.example/x.jpg',fetchImpl:async(_url,init)=>{body=JSON.parse(init.body);headers=init.headers;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(note)}}]}));}});
  assert.deepEqual(result,note);assert.equal(headers.Authorization,'Bearer legacy-secret');assert.equal(headers['x-api-key'],undefined);assert.deepEqual(body.response_format,{type:'json_object'});
  await assert.rejects(imageRequest.requestImageRemark({endpoint:'https://text.example',apiKey:'legacy-secret',fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'```json\n'+JSON.stringify(note)+'\n```'}}]}))}));
});

test('messages provider errors keep credentials and raw bodies out of diagnostics',async()=>{
  await assert.rejects(imageRequest.requestImageRemark({protocol:'anthropic-messages',endpoint:'https://vision.example/v1/messages',apiKey:'vision-secret',fetchImpl:async()=>new Response('vision-secret provider body',{status:503})}),e=>{
    assert.deepEqual(imageRequest.readImageRemarkFailureDiagnostic(e),{stage:'http-response',httpStatus:503,errorClass:'http'});
    assert(!e.message.includes('secret'));return true;
  });
});
