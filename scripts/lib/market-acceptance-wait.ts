import { setTimeout as delay } from 'node:timers/promises';

type View = { run: { status: string }; steps: readonly { status: string; nextAttemptAt?: string | null }[] };
/** Acceptance driver only. Durable workers retain ownership of retries and source reuse. */
export async function waitForMarketAcceptance<T extends View>(options: {
  tick: () => Promise<boolean>; read: () => Promise<T | null>; deadline: number;
  signal?: AbortSignal; now?: () => number; sleep?: (ms: number) => Promise<void>;
  onView?: (view: T) => Promise<'stop' | void> | 'stop' | void;
}): Promise<{ kind: 'terminal' | 'deadline' | 'cancelled' | 'stopped'; view: T | null }> {
  const now = options.now ?? Date.now;
  let view: T | null = null;
  while (true) {
    if (options.signal?.aborted) return { kind: 'cancelled', view };
    if (now() >= options.deadline) return { kind: 'deadline', view };
    const worked = await options.tick();
    view = await options.read();
    if (view) {
      if (await options.onView?.(view) === 'stop') return { kind: 'stopped', view };
      const pending = view.steps.some(step => step.status === 'queued' || step.status === 'running');
      if (['succeeded', 'failed', 'cancelled'].includes(view.run.status) || (view.run.status === 'partial' && !pending)) return { kind: 'terminal', view };
    }
    if (worked) continue;
    const due = view?.steps.filter(step => step.status === 'queued').map(step => Date.parse(step.nextAttemptAt ?? '')).filter(Number.isFinite) ?? [];
    const next = due.length ? Math.min(...due) : now() + 1000;
    // Poll cancellation and DB changes at least once per second; never spin while waiting.
    const ms = Math.max(1, Math.min(1000, Math.max(50, next - now()), options.deadline - now()));
    try {
      if (options.sleep) await options.sleep(ms);
      else await delay(ms, undefined, { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) return { kind: 'cancelled', view };
      throw error;
    }
  }
}
