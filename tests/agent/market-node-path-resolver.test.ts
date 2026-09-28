import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorRequest, RemoteMcpConnector } from '../../server/connectors/connector-contract';
import { resolveMarketNodePath } from '../../server/services/market-node-path-resolver';

function connector(handler: (request: ConnectorRequest) => unknown): RemoteMcpConnector {
  return {
    id: 'sellerSprite',
    probe: async () => ({ connectorId: 'sellerSprite', configured: true, available: true, reason: null, checkedAt: null }),
    execute: async request => ({
      data: await handler(request) as Record<string, unknown>,
      source: { connectorId: 'sellerSprite', operation: request.operation, fetchedAt: '2026-09-22T00:00:00.000Z', attemptCount: 1 },
    }),
  };
}

test('bare category node resolves to the unique canonical path', async () => {
  const calls: ConnectorRequest[] = [];
  const path = await resolveMarketNodePath({
    marketplace: 'US', nodeId: '1063294', month: '2026-08', organizationId: 'org-a', jobId: 'job-a',
    connector: connector(request => { calls.push(request); return { code: 'OK', data: [
      { nodeIdPath: '123:1063294', nodeLabelPath: 'Tools > Floor Lamps' },
    ] }; }),
  });
  assert.equal(path, '123:1063294');
  assert.equal(calls[0]?.operation, 'product_node');
  assert.deepEqual(calls[0]?.input, { request: { marketplace: 'US', keyword: '1063294', month: '202608' } });
});

test('same leaf with multiple paths follows the original first matching result', async () => {
  const path=await resolveMarketNodePath({
    marketplace: 'US', nodeId: '1063294', month: '2026-08', organizationId: 'org-a', jobId: 'job-a',
    connector: connector(() => ({ data: [
      { nodeIdPath: '123:1063294' }, { nodeIdPath: '456:1063294' },
    ] })),
  });assert.equal(path,'123:1063294');
});
