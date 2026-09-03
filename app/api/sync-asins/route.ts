import { proxyAgentRequest } from "../agent/[...path]/route";
import {
  createAgentServiceClient,
  type AgentServiceClient,
} from "../../lib/agent-service-client";

const localSyncPath = ["v1", "local-data", "sync-asins"];

/** Compatibility endpoint; the authenticated Agent alone may create sync jobs. */
export function proxyLegacySyncAsinsRequest(
  request: Request,
  client: AgentServiceClient = createAgentServiceClient(),
) {
  return proxyAgentRequest(
    request,
    { params: Promise.resolve({ path: localSyncPath }) },
    client,
  );
}

export async function GET(request: Request) {
  return proxyLegacySyncAsinsRequest(request);
}

export async function POST(request: Request) {
  return proxyLegacySyncAsinsRequest(request);
}
