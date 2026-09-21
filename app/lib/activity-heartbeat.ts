import { ActivityResponseSchema } from "../../shared/agent-contracts";
import { localAgentFetch } from "./local-agent-browser";
import { USAGE_REPORT_INTERVAL_MS } from "../../shared/usage-analytics-contracts";

export type ActivityHeartbeatFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type ActivityHeartbeatScheduler = Readonly<{
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}>;

export type ActivityHeartbeatVisibility = Readonly<{
  isVisible: () => boolean;
  subscribe: (listener: () => void) => () => void;
}>;

export type ActivityHeartbeatControllerDependencies = Readonly<{
  scheduler: ActivityHeartbeatScheduler;
  visibility: ActivityHeartbeatVisibility;
  send: (signal: AbortSignal) => Promise<unknown>;
  intervalMs?: number;
}>;

const HEARTBEAT_INTERVAL_MS = USAGE_REPORT_INTERVAL_MS;

export async function sendActivityHeartbeat(
  signal: AbortSignal,
  fetchImpl: ActivityHeartbeatFetch = localAgentFetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl("/v1/auth/activity", { method: "POST", signal });
    if (!response.ok) return false;
    return ActivityResponseSchema.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}

export class ActivityHeartbeatController {
  private readonly intervalMs: number;
  private started = false;
  private visible = false;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private inFlight: AbortController | null = null;
  private generation = 0;

  constructor(private readonly dependencies: ActivityHeartbeatControllerDependencies) {
    this.intervalMs = dependencies.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.dependencies.visibility.subscribe(() => this.visibilityChanged());
    this.visible = this.dependencies.visibility.isVisible();
    if (this.visible) this.enterVisibleState();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.visible = false;
    this.generation += 1;
    this.clearTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.abortInFlight();
  }

  private visibilityChanged(): void {
    if (!this.started) return;
    const visible = this.dependencies.visibility.isVisible();
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      this.enterVisibleState();
      return;
    }
    this.generation += 1;
    this.clearTimer();
    this.abortInFlight();
  }

  private enterVisibleState(): void {
    this.attempt();
    this.scheduleNextCycle();
  }

  private attempt(): void {
    if (!this.started || !this.visible || this.inFlight !== null) return;
    const controller = new AbortController();
    const generation = this.generation;
    this.inFlight = controller;

    let request: Promise<unknown>;
    try {
      request = this.dependencies.send(controller.signal);
    } catch (error) {
      request = Promise.reject(error);
    }
    void request.catch(() => undefined).finally(() => {
      if (this.generation === generation && this.inFlight === controller) {
        this.inFlight = null;
      }
    });
  }

  private scheduleNextCycle(): void {
    if (!this.started || !this.visible) return;
    this.clearTimer();
    this.timer = this.dependencies.scheduler.setTimeout(() => {
      this.timer = null;
      if (!this.started || !this.visible) return;
      this.attempt();
      this.scheduleNextCycle();
    }, this.intervalMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.dependencies.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  private abortInFlight(): void {
    const controller = this.inFlight;
    this.inFlight = null;
    controller?.abort();
  }
}

export function createBrowserActivityHeartbeatController(): ActivityHeartbeatController {
  return new ActivityHeartbeatController({
    scheduler: {
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    },
    visibility: {
      isVisible: () => document.visibilityState === "visible",
      subscribe: (listener) => {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
    },
    send: (signal) => sendActivityHeartbeat(signal),
  });
}
