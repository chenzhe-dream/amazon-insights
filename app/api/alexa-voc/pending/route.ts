import { AlexaVocNormalizationStatusQuerySchema } from "../../../../shared/agent-contracts";
import {
  createAgentServiceClient,
  getAlexaVocNormalizationStatus,
  type AgentServiceClient,
} from "../../../lib/agent-service-client";

type PendingDependencies = Readonly<{
  client: AgentServiceClient;
  uiEnabled: boolean;
}>;

function serviceHeaders(request: Request) {
  const headers = new Headers({ origin: new URL(request.url).origin });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

export function createAlexaVocPendingHandler(dependencies: Partial<PendingDependencies> = {}) {
  const client = dependencies.client ?? createAgentServiceClient();
  const uiEnabled = dependencies.uiEnabled ?? true;
  return async function handleAlexaVocPending(request: Request) {
    const incoming = new URL(request.url);
    const parsed = AlexaVocNormalizationStatusQuerySchema.safeParse({
      projectId: incoming.searchParams.get("projectId"),
      runId: incoming.searchParams.get("runId"),
      marketplace: incoming.searchParams.get("marketplace"),
      asins: incoming.searchParams.getAll("asins"),
    });
    if (!parsed.success) return Response.json({ error: "Alexa VOC 状态查询无效" }, { status: 400 });
    if (!uiEnabled) return Response.json({ records: [] });
    const result = await getAlexaVocNormalizationStatus({
      client,
      marketplace: parsed.data.marketplace,
      projectId: parsed.data.projectId,
      runId: parsed.data.runId,
      asins: parsed.data.asins,
      headers: serviceHeaders(request),
      requestId: request.headers.get("x-request-id") ?? undefined,
    });
    const headers = new Headers({ "content-type": "application/json" });
    for (const name of ["x-request-id", "retry-after"] as const) {
      const value = result.headers.get(name);
      if (value) headers.set(name, value);
    }
    return Response.json(result.body, { status: result.status, headers });
  };
}

export const GET = createAlexaVocPendingHandler({
  uiEnabled: process.env.MANUAL_ALEXA_VOC_UI_ENABLED === "1",
});
