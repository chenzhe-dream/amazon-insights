import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { governExternalRequest } from './postgres-resource-governor.mjs';
import { safeSellerSpriteTransportError } from '../../server/connectors/mcp-transport.mjs';

// One owner per connector. No process-global credential/client cache.
export function createSellerSpriteSessionPool({ maxEntries = 32, idleTimeoutMs = 30_000 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 256 || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 300_000) throw new TypeError('Invalid MCP pool limits');
  const entries = new Map();
  let closed = false;
  async function retire(entry) {
    clearTimeout(entry.timer);
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    entry.lifetime.abort();
    await entry.client.close().catch(() => undefined);
  }
  return {
    async request(secret, endpoint, method, params, options) {
      if (closed) throw new Error('MCP session pool is closed');
      const key = JSON.stringify([options.organizationId, options.jobId, createHash('sha256').update(secret).digest('hex'), endpoint, 'streamable-http/sdk-1.30.0']);
      const deadline = rpcDeadline(options.signal, options.timeoutMs ?? 15_000);
      const signal = deadline.signal;
      try {
        signal.throwIfAborted();
        let entry = entries.get(key);
        if (!entry) {
          if (entries.size >= maxEntries) {
            const idle = [...entries.values()].find(value => value.pending === 0);
            if (!idle) throw new Error('MCP session pool capacity is busy');
            // Delete synchronously before awaiting teardown, preserving the hard bound.
            void retire(idle);
          }
          entry = { key, client: new Client({name:'amazon-opportunity-insights',version:'1.0.0'}), lifetime: new AbortController(), pending:0, tail:Promise.resolve(), connected:false, active:null, timer:undefined };
          const owner = entry;
          owner.transport = new StreamableHTTPClientTransport(new URL(endpoint), {
            requestInit: { headers: {'secret-key':secret}, redirect:'error' },
            reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1,maxReconnectionDelay:1,reconnectionDelayGrowFactor:1},
            fetch: async (input, init = {}) => {
              // Snapshot this RPC's attribution before the first await. GET stream lifetime
              // belongs to the session; POSTs, including cancellation, belong to the RPC.
              const active = owner.active;
              const context = active?.options ?? { organizationId:options.organizationId,jobId:options.jobId,env:options.env,resourceGovernor:options.resourceGovernor,requireResourceGovernor:options.requireResourceGovernor,fetchImpl:options.fetchImpl };
              const signals = [owner.lifetime.signal, init.signal];
              if (init.method !== 'GET' && active) signals.push(active.signal);
              const fetchSignal = AbortSignal.any(signals.filter(Boolean));
              return governExternalRequest({resourceGovernor:context.resourceGovernor,requireResourceGovernor:context.requireResourceGovernor,env:context.env,organizationId:context.organizationId,jobId:context.jobId,resource:'sellerSprite',attemptKind:context.attemptKind ?? 'initial',signal:fetchSignal,
                operation:async()=>{
                  if (active && typeof init.body === 'string') {
                    const body = JSON.parse(init.body);
                    if (body.method === 'tools/call') {
                      await context.onPhysicalDispatch?.();
                      active.dispatched = true;
                    }
                  }
                  return (context.fetchImpl ?? fetch)(input,{...init,signal:fetchSignal,redirect:'error'});
                }});
            },
          });
          entries.set(key, entry);
        }
        clearTimeout(entry.timer);
        entry.pending++;
        const owner = entry;
        let started = false;
        const work = owner.tail.then(async () => {
          started = true;
          signal.throwIfAborted();
          if (closed || owner.lifetime.signal.aborted) throw new Error('MCP session is closed');
          const active = {options,signal,dispatched:false}; owner.active = active;
          try {
            if (!owner.connected) {
              await owner.client.connect(owner.transport,{signal});
              owner.connected = true;
            }
            return method === 'tools/list' ? await owner.client.listTools(undefined,{signal}) : await owner.client.callTool({name:params.name,arguments:params.arguments},undefined,{signal});
          } catch(error) {
            await retire(owner);
            const safe = error instanceof Error && error.name === 'ResourceGovernorAdmissionError' ? error : safeSellerSpriteTransportError(error,signal,{boundary:'rpc-envelope'});
            if (active.dispatched) safe.doNotRetry = true;
            throw safe;
          } finally { owner.active = null; }
        });
        owner.tail = work.catch(()=>undefined).finally(()=>{
          owner.pending--;
          if (owner.pending === 0 && entries.get(key) === owner) {
            owner.timer = setTimeout(()=>{void retire(owner);},idleTimeoutMs);
            owner.timer.unref?.();
          }
        });
        // A queued cancellation returns promptly without touching the active RPC.
        return await abortable(work,signal,()=>!started);
      } finally {
        deadline.dispose();
      }
    },
    async close() {
      closed = true;
      await Promise.all([...entries.values()].map(retire));
    },
  };
}

// SDK 1.30 retains its abort listeners after RPC completion. Never expose a
// caller's long-lived signal or an uncancellable timeout directly to the SDK.
function rpcDeadline(parent, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) throw new RangeError('Invalid MCP request timeout');
  const controller = new AbortController();
  const forward = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', forward, { once: true });
  if (parent?.aborted) forward();
  const timer = setTimeout(() => controller.abort(new DOMException('MCP request timed out', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', forward);
    },
  };
}

function abortable(promise, signal, canCancel) {
  return new Promise((resolve,reject)=>{
    const abort=()=>{if(canCancel()) reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted) abort();
  });
}
