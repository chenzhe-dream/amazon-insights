import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelDiagnosticFetch, type ModelNetworkDiagnostic } from '../../server/runtime/model-network-diagnostics';

test('diagnostic fetch observes headers and complete body without leaking request data', async () => {
  const events: ModelNetworkDiagnostic[] = [];
  const wrapped = createModelDiagnosticFetch(async () => new Response('private body', { status: 200 }), entry => events.push(entry));
  const response = await wrapped('https://secret.invalid/?key=secret', { headers: { Authorization: 'secret' } });
  assert.equal(await response.text(), 'private body');
  assert.deepEqual(events.map(e => e.phase), ['dispatch', 'headers', 'body-complete']);
  assert.equal(new Set(events.map(e => e.requestId)).size, 1);
  assert.equal(events[1].status, 200);
  assert.equal(events[2].dnsMs, null);
  assert.doesNotMatch(JSON.stringify(events), /secret|private body/);
});
test('header and body errors remain distinguishable, logger failure never changes operation', async () => {
  const events: ModelNetworkDiagnostic[] = [];
  const fail = new Error('sensitive upstream body');
  const before = createModelDiagnosticFetch(async () => { throw fail; }, e => events.push(e));
  await assert.rejects(before('https://example.invalid'), e => e === fail);
  assert.equal(events.at(-1)?.phase, 'transport-error'); assert.equal(events.at(-1)?.headersMs, null);
  const body = createModelDiagnosticFetch(async () => new Response(new ReadableStream({ start(c) { c.error(fail); } })), e => events.push(e));
  await assert.rejects((await body('https://example.invalid')).text(), e => e === fail);
  assert.equal(events.at(-1)?.phase, 'body-error'); assert.notEqual(events.at(-1)?.headersMs, null);
  assert.doesNotMatch(JSON.stringify(events), /sensitive/);
  assert.equal(await (await createModelDiagnosticFetch(async () => new Response('ok'), () => { throw fail; })('https://example.invalid')).text(), 'ok');
});
test('concurrent requests have independent traces and cancellation cancels the source body', async () => {
  const events: ModelNetworkDiagnostic[] = []; let cancelled = false;
  const wrapped = createModelDiagnosticFetch(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), e => events.push(e));
  const [a,b] = await Promise.all([wrapped('https://example.invalid'), wrapped('https://example.invalid')]);
  await a.body!.cancel(); await b.body!.cancel();
  assert.equal(cancelled, true); assert.equal(new Set(events.map(e => e.requestId)).size, 2);
  assert.equal(events.filter(e => e.phase === 'body-cancelled').length, 2);
});

test('abort diagnostics carry only closed reasons, never arbitrary signal.reason text', async () => {
  for (const reason of [new DOMException('private timeout', 'TimeoutError'), new Error('private secret')]) {
    const events: ModelNetworkDiagnostic[] = [], controller = new AbortController();
    const wrapped = createModelDiagnosticFetch(async () => { controller.abort(reason); throw reason; }, e => events.push(e));
    await assert.rejects(wrapped('https://example.invalid', { signal: controller.signal }));
    assert.equal(events.at(-1)?.abortReason, reason.name === 'TimeoutError' ? 'timeout' : 'signal-aborted');
    assert.doesNotMatch(JSON.stringify(events), /private|secret/);
  }
});
