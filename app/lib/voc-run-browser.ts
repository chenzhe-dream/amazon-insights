import { localAgentErrorMessage, localAgentFetch } from "./local-agent-browser";

const entityId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BrowserFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function vocRunIdFromSearch(search: string | URLSearchParams) {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const value = params.get("run");
  return value && entityId.test(value) ? value : null;
}

export function searchWithVocRunId(search: string | URLSearchParams, runId: string) {
  if (!entityId.test(runId)) throw new TypeError("Invalid VOC run identifier");
  const params = new URLSearchParams(typeof search === "string" ? search : search.toString());
  params.set("run", runId);
  return params;
}

export type VocRunObservation = {
  kind: "active" | "waiting-input" | "failed" | "succeeded" | "offline";
  runId: string | null;
  stage: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  reports: Array<Record<string, unknown>>;
  message: string;
};

export class VocRunClientError extends Error {
  constructor(
    readonly kind: "waiting-input" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "VocRunClientError";
  }
}

async function responseJson(response: Response, fallback: string) {
  const payload = await response.json();
  if (!response.ok) throw new Error(localAgentErrorMessage(payload, fallback));
  return payload;
}

function assertRunId(runId: string) {
  if (!entityId.test(runId)) throw new TypeError("Invalid VOC run identifier");
}

async function postAction(path: string, fetchImpl: BrowserFetch, fallback: string) {
  const response = await fetchImpl(path, { method: "POST", body: "{}" });
  const payload = await response.json();
  if (!response.ok) {
    throw new VocRunClientError(
      response.status === 422 ? "waiting-input" : "failed",
      localAgentErrorMessage(payload, fallback),
    );
  }
}

export async function submitVocRun(
  asins: string[],
  marketplace = "US",
  fetchImpl: BrowserFetch = localAgentFetch,
) {
  const response = await fetchImpl("/v1/local-voc", {
    method: "POST",
    body: JSON.stringify({ asins, marketplace }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = localAgentErrorMessage(payload, "VOC analysis submission failed");
    throw new VocRunClientError(response.status === 422 ? "waiting-input" : "failed", message);
  }
  return payload as { projectId: string; runId: string };
}

export async function observeVocRun(
  runId: string,
  fetchImpl: BrowserFetch = localAgentFetch,
): Promise<VocRunObservation> {
  try {
    const [runResponse, reportsResponse] = await Promise.all([
      fetchImpl(`/v1/runs/${encodeURIComponent(runId)}`),
      fetchImpl(`/v1/runs/${encodeURIComponent(runId)}/reports`),
    ]);
    const run = await responseJson(runResponse, "Unable to read VOC run") as {
      stages?: Array<Record<string, unknown>>;
    };
    const reports = await responseJson(reportsResponse, "Unable to read VOC reports") as {
      reports?: Array<Record<string, unknown>>;
    };
    const stage = run.stages?.find((item) => item.stage === "voc-positioning") ?? null;
    const reportHistory = reports.reports ?? [];
    const report = reportHistory.find((item) => item.stage === "voc-positioning") ?? null;
    const status = typeof stage?.status === "string" ? stage.status : "queued";
    const kind: VocRunObservation["kind"] = report
      ? "succeeded"
      : status === "waiting-input"
        ? "waiting-input"
        : status === "failed"
          ? "failed"
          : "active";
    return {
      kind,
      runId,
      stage,
      report,
      reports: reportHistory,
      message: kind === "succeeded" ? "VOC report is persisted" : `VOC stage: ${status}`,
    };
  } catch (error) {
    if (error instanceof TypeError) {
      return {
        kind: "offline",
        runId,
        stage: null,
        report: null,
        reports: [],
        message: "Agent Service is offline. Run: npm run agent:dev",
      };
    }
    throw error;
  }
}

export async function waitForVocRun(
  runId: string,
  options: {
    attempts?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    fetchImpl?: BrowserFetch;
    onObservation?: (observation: VocRunObservation) => void;
  } = {},
) {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.fetchImpl ?? localAgentFetch;
  let observation = await observeVocRun(runId, fetchImpl);
  options.onObservation?.(observation);
  for (let index = 1; index < attempts && observation.kind === "active"; index += 1) {
    await sleep(intervalMs);
    observation = await observeVocRun(runId, fetchImpl);
    options.onObservation?.(observation);
  }
  return observation;
}

export async function cancelVocRun(runId: string, fetchImpl: BrowserFetch = localAgentFetch) {
  assertRunId(runId);
  await postAction(`/v1/runs/${encodeURIComponent(runId)}/cancel`, fetchImpl, "Unable to cancel VOC run");
  return observeVocRun(runId, fetchImpl);
}

export async function retryVocStage(
  runId: string,
  stage = "voc-positioning",
  fetchImpl: BrowserFetch = localAgentFetch,
) {
  assertRunId(runId);
  await postAction(
    `/v1/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stage)}/retry`,
    fetchImpl,
    "Unable to retry VOC stage",
  );
  return observeVocRun(runId, fetchImpl);
}
