import assert from 'node:assert/strict';
import test from 'node:test';
import { agentRequestTimeoutMs } from '../../app/lib/agent-service-client';
test('traffic recovery proxy outlives the service deadline without changing other routes', () => {
  assert.equal(agentRequestTimeoutMs('/v1/runs/:runId/traffic-details/refresh'), 55000);
  assert.equal(agentRequestTimeoutMs('/v1/capabilities'), 10000);
  assert.equal(agentRequestTimeoutMs('/v1/runs/:runId/traffic-details/refresh', 5), 5);
});
