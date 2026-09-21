import { randomUUID } from 'node:crypto';

export type ModelNetworkDiagnostic = Readonly<{
  version: 'model-fetch-phases/v1'; requestId: string;
  phase: 'dispatch' | 'headers' | 'body-complete' | 'transport-error' | 'body-error' | 'body-cancelled';
  elapsedMs: number; headersMs: number | null; status: number | null;
  aborted: boolean; dnsMs: null; tcpMs: null; tlsMs: null;
  abortReason: 'timeout' | 'signal-aborted' | 'consumer-cancelled' | null;
}>;

/** Observe only stages exposed by fetch. Never infer DNS, relay queue or generation latency. */
export function createModelDiagnosticFetch(fetcher: typeof fetch, logger: (entry: ModelNetworkDiagnostic) => void): typeof fetch {
  return async (input, init) => {
    const start = performance.now(), requestId = randomUUID();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let headersMs: number | null = null, status: number | null = null;
    const emit = (phase: ModelNetworkDiagnostic['phase']) => {
      try { logger(Object.freeze({ version: 'model-fetch-phases/v1', requestId, phase,
        elapsedMs: Math.round(performance.now() - start), headersMs, status,
        aborted: signal?.aborted ?? false,
        abortReason: signal?.aborted ? (signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'timeout' : 'signal-aborted')
          : phase === 'body-cancelled' ? 'consumer-cancelled' : null,
        dnsMs: null, tcpMs: null, tlsMs: null })); } catch { /* Observability must not affect billing or request outcomes. */ }
    };
    emit('dispatch');
    let response: Response;
    try { response = await fetcher(input, init); } catch (error) { emit('transport-error'); throw error; }
    headersMs = Math.round(performance.now() - start); status = response.status; emit('headers');
    if (!response.body) { emit('body-complete'); return response; }
    const reader = response.body.getReader();
    let finished = false;
    const finish = (phase: ModelNetworkDiagnostic['phase']) => { if (!finished) { finished = true; emit(phase); } };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) { finish('body-complete'); controller.close(); }
          else controller.enqueue(result.value);
        } catch (error) { finish('body-error'); controller.error(error); }
      },
      async cancel(reason) { finish('body-cancelled'); await reader.cancel(reason); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
