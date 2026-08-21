import { proxyAgentRequest } from "../../agent/[...path]/route";
import {
  createAgentServiceClient,
  type AgentServiceClient,
} from "../../../lib/agent-service-client";

type RouteContext = { params: Promise<{ jobId: string }> };

/** Compatibility endpoint; ownership and response normalization stay in the Agent. */
export async function proxyLegacySyncJobRequest(
  request: Request,
  context: RouteContext,
  client: AgentServiceClient = createAgentServiceClient(),
) {
  const { jobId } = await context.params;
  return proxyAgentRequest(
    request,
    { params: Promise.resolve({ path: ["v1", "local-data", "sync-asins", jobId] }) },
    client,
  );
}

export async function GET(request: Request, context: RouteContext) {
  return proxyLegacySyncJobRequest(request, context);
}
