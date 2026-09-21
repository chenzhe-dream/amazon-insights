import test from 'node:test';
import assert from 'node:assert/strict';
import { createSellerSpriteConnector } from '../../server/connectors/mcp-connectors';
import { startFakeSellerSpriteMcpServer } from './helpers/fake-sellersprite-mcp-server';

test('market connector owns SDK reuse and closes it at owner shutdown', async t => {
 const server=await startFakeSellerSpriteMcpServer();t.after(()=>server.close());
 const connector=createSellerSpriteConnector({env:{NODE_ENV:'test',SELLERSPRITE_MCP_ENDPOINT:server.url},resolveCredential:async()=> 'test-secret',policy:{timeoutMs:1000,maxAttempts:2,retryDelayMs:1,maxConcurrent:2,maxQueue:4}});
 t.after(()=>connector.close?.());
 const request={operation:'example',input:{},sessionScope:'market' as const,governorScope:{organizationId:'org',jobId:'run'}};
 await connector.execute(request);await connector.execute(request);
 assert.equal(server.requests.filter(x=>x.method==='initialize').length,1);
 await connector.close?.();await assert.rejects(connector.execute(request));
 assert.equal(server.requests.filter(x=>x.method==='tools/call').length,2);
});

test('owner shutdown aborts active SDK request without retrying business dispatch', async t => {
 const server=await startFakeSellerSpriteMcpServer({mode:'operation-hang'});t.after(()=>server.close());
 const connector=createSellerSpriteConnector({env:{NODE_ENV:'test',SELLERSPRITE_MCP_ENDPOINT:server.url},resolveCredential:async()=> 'test-secret',policy:{timeoutMs:1000,maxAttempts:2,retryDelayMs:1,maxConcurrent:2,maxQueue:4}});
 t.after(()=>connector.close?.());
 const pending=connector.execute({operation:'example',input:{},sessionScope:'market',governorScope:{organizationId:'org',jobId:'run'}});
 const rejected=assert.rejects(pending);
 await server.waitForRequest('tools/call');await connector.close?.();await rejected;
 assert.equal(server.requests.filter(x=>x.method==='tools/call').length,1);
});

test('pooled SSE stream outlives first RPC deadline and closes on idle expiry', async t => {
 const {createSellerSpriteSessionPool,requestSellerSpriteMcp}=await import('../../scripts/lib/sellersprite-mcp-client.mjs');
 const server=await startFakeSellerSpriteMcpServer({mode:'get-hang'});t.after(()=>server.close());
 const pool=createSellerSpriteSessionPool({idleTimeoutMs:150});t.after(()=>pool.close());
 const options={env:{NODE_ENV:'test',SELLERSPRITE_MCP_ENDPOINT:server.url},sessionPool:pool,sessionScope:'market' as const,organizationId:'org',jobId:'run',timeoutMs:50};
 await requestSellerSpriteMcp('secret','tools/call',{name:'example',arguments:{}},options);
 await new Promise(resolve=>setTimeout(resolve,75));
 await requestSellerSpriteMcp('secret','tools/call',{name:'example',arguments:{}},options);
 assert.equal(server.requests.filter(x=>x.method==='initialize').length,1);
 await server.waitForGetClose();
});
