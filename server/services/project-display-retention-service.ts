type Cleanup = (input: { now?: string; limit?: number }) => Promise<{ purgedCount: number }>;

/** Sweeps retired report bodies after their 24-hour rollback window. */
export class ProjectDisplayRetentionService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly options: {
    cleanup: Cleanup;
    onError?: (error: unknown) => void;
    intervalMs?: number;
  }) {}

  start(): void {
    if (this.timer) return;
    this.sweep();
    this.timer = setInterval(() => this.sweep(), this.options.intervalMs ?? 60 * 60 * 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }

  private sweep(): void {
    if (this.pending) return;
    this.pending = this.options.cleanup({ limit: 100 })
      .then(() => undefined)
      .catch(error => this.options.onError?.(error))
      .finally(() => { this.pending = null; });
  }
}
