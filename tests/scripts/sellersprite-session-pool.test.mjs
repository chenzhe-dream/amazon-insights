import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import * as api from '../../scripts/lib/sellersprite-mcp-client.mjs';

async function fixture(t, poolOptions = {}) {
  assert.equal(typeof api.createSellerSpriteSessionPool, 'function', 'scoped session pool must exist');
  const requests = []; let session = 0; let failNext = false; let hold = false; let activeBusiness = 0; let maxActiveBusiness = 0;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const msg = body ? JSON.parse(body) : {};
    requests.push({ method: req.method, rpc: msg.method, session: req.headers['mcp-session-id'], secret: req.headers['secret-key'] });
    if(req.method === 'GET') { res.writeHead(405).end(); return; }
    if(!msg.id && msg.id !== 0) { res.writeHead(202).end(); return; }
    if(msg.method === 'tools/call' && failNext) { failNext=false; res.writeHead(404).end(); return; }
    if(msg.method === 'tools/call') { activeBusiness++; maxActiveBusiness=Math.max(maxActiveBusiness,activeBusiness); await new Promise(resolve => setTimeout(resolve, hold ? 150 : 5)); activeBusiness--; }
    const result = msg.method === 'initialize' ? {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}} : {content:[{type:'text',text:'{}'}]};
    res.writeHead(200, {'content-type':'application/json', ...(msg.method === 'initialize' ? {'mcp-session-id':String(++session)} : {})});
    res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const pool = api.createSellerSpriteSessionPool(poolOptions);
  t.after(async()=>{await pool.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const env={NODE_ENV:'test',SELLERSPRITE_MCP_ENDPOINT:`http://127.0.0.1:${server.address().port}/mcp`};
  const attempts=[];
  const resourceGovernor={ async run(input) { attempts.push(input); return input.operation(); } };
  const call=(options={}, secret='credential-a')=>api.requestSellerSpriteMcp(secret,'tools/call',{name:'example',arguments:{}},{env,resourceGovernor,sessionPool:pool,sessionScope:'market',organizationId:'org-a',jobId:'run-a',...options});
  return {pool,call,requests,attempts,env,maxActive:()=>maxActiveBusiness,fail:()=>{failNext=true;},hold:()=>{hold=true;}};
}
const handshakes=f=>f.requests.filter(r=>r.rpc==='initialize').length;
test('completed RPC deadlines and later parent aborts emit no cancellation HTTP or governor attempts',async t=>{
 const f=await fixture(t,{idleTimeoutMs:2000});
 const parent=new AbortController();
 await f.call({timeoutMs:300,signal:parent.signal});
 await f.call({timeoutMs:300});
 const before=f.requests.length;
 parent.abort(new Error('caller finished'));
 await new Promise(resolve=>setTimeout(resolve,450));
 assert.equal(f.requests.filter(r=>r.rpc==='notifications/cancelled').length,0);
 assert.equal(f.requests.length,before);
 assert.equal(f.attempts.length,before);
 await f.call();
 assert.equal(handshakes(f),1);
});

test('queued deadline returns promptly without retiring the active session',async t=>{
 const f=await fixture(t);await f.call();f.hold();
 const active=f.call({timeoutMs:1000});
 await assert.rejects(f.call({timeoutMs:30}),e=>e.name==='TimeoutError');
 await active;await f.call();
 assert.equal(handshakes(f),1);
 assert.equal(f.requests.filter(r=>r.rpc==='tools/call').length,3);
});

test('in-flight deadline retires session and prohibits business replay',async t=>{
 const f=await fixture(t);await f.call();f.hold();
 await assert.rejects(f.call({timeoutMs:50}),e=>e.doNotRetry===true);
 await f.call();
 assert.equal(handshakes(f),2);
 assert.equal(f.requests.filter(r=>r.rpc==='tools/call').length,3);
});

test('actual SDK reuses one handshake and serializes concurrent market calls',async t=>{
 const f=await fixture(t);await Promise.all([f.call(),f.call(),f.call()]);assert.equal(handshakes(f),1);assert.equal(f.requests.filter(r=>r.rpc==='tools/call').length,3);assert.equal(f.requests.length,6);assert.equal(f.maxActive(),1);
});
test('org, run, credential and endpoint isolate; unscoped stays one-shot',async t=>{
 const f=await fixture(t);await f.call();await f.call({organizationId:'org-b'});await f.call({jobId:'run-b'});await f.call({},'credential-b');await f.call({env:{...f.env,SELLERSPRITE_MCP_ENDPOINT:f.env.SELLERSPRITE_MCP_ENDPOINT+'/other'}});await f.call({sessionScope:undefined});await f.call({sessionScope:undefined});assert.equal(handshakes(f),7);
});
test('idle expiry, bounded eviction, shutdown and no use after close',async t=>{
 const f=await fixture(t,{idleTimeoutMs:25,maxEntries:1});await f.call();await new Promise(r=>setTimeout(r,60));await f.call();assert.equal(handshakes(f),2);await f.call({jobId:'other'});await f.call();assert.equal(handshakes(f),4);await f.pool.close();await assert.rejects(f.call());
});
test('failed dispatched business request is never replayed; next call rebuilds',async t=>{
 const f=await fixture(t);await f.call();f.fail();await assert.rejects(f.call(), e=>e.doNotRetry===true);assert.equal(f.requests.filter(r=>r.rpc==='tools/call').length,2);await f.call();assert.equal(handshakes(f),2);
});
test('queued cancellation does not kill active session; per call abort does not poison other run',async t=>{
 const f=await fixture(t);await f.call();f.hold();const active=f.call();const c=new AbortController();const queued=f.call({signal:c.signal});c.abort();await assert.rejects(queued);await active;await f.call({jobId:'other'});const d=new AbortController();const cancelled=f.call({signal:d.signal});setTimeout(()=>d.abort(),25);await assert.rejects(cancelled,e=>e.doNotRetry===true);await f.call({jobId:'other'});assert.equal(handshakes(f),2);
});

test('every physical request is governed with current attempt attribution; busy bound rejects before HTTP',async t=>{
 const f=await fixture(t,{maxEntries:1});await f.call();await f.call({attemptKind:'retry'});
 assert.equal(f.attempts.length,f.requests.length);assert.equal(f.attempts.at(-1).attemptKind,'retry');
 assert.ok(f.attempts.every(a=>a.organizationId==='org-a'&&a.jobId==='run-a'));
 f.hold();const active=f.call();await assert.rejects(f.call({jobId:'other'}),/capacity/);await active;
 assert.equal(handshakes(f),1);
});

test('local admission denial dispatches nothing and preserves exact error metadata',async t=>{
 const f=await fixture(t);const error=Object.assign(new Error('safe admission'),{name:'ResourceGovernorAdmissionError',reason:'rolling-window',retryAt:'2026-09-17T00:00:00.000Z'});
 await assert.rejects(f.call({resourceGovernor:{run:async()=>{throw error;}}}),e=>e===error);
 assert.equal(f.requests.length,0);await f.call();assert.equal(handshakes(f),1);
});
