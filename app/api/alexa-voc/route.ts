import { ManualAlexaVocListQuerySchema } from "../../../shared/agent-contracts";
import {
  createAgentServiceClient,
  type AgentServiceClient,
  type AgentServiceResult,
} from "../../lib/agent-service-client";

type ListDependencies = Readonly<{
  client: AgentServiceClient;
  uiEnabled: boolean;
}>;

function serviceHeaders(request: Request) {
  const headers = new Headers({ origin: new URL(request.url).origin });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

function responseHeaders(result: AgentServiceResult) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["x-request-id", "retry-after"] as const) {
    const value = result.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export function createAlexaVocListHandler(
  dependencies: Partial<ListDependencies> = {},
) {
  const client = dependencies.client ?? createAgentServiceClient();
  const uiEnabled = dependencies.uiEnabled ?? true;
  return async function handleAlexaVocList(request: Request) {
    const incoming = new URL(request.url);
    const parsed = ManualAlexaVocListQuerySchema.safeParse({
      projectId: incoming.searchParams.get("projectId"),
      marketplace: incoming.searchParams.get("marketplace"),
      asins: incoming.searchParams.getAll("asins"),
    });
    if (!parsed.success) {
      return Response.json({ error: "Alexa VOC 查询无效" }, { status: 400 });
    }
    if (!uiEnabled) return Response.json({ records: [] });
    const query = new URLSearchParams({ projectId: parsed.data.projectId, marketplace: parsed.data.marketplace });
    for (const asin of parsed.data.asins) query.append("asins", asin);
    const result = await client({
      method: "GET",
      path: `/v1/manual-alexa-voc?${query.toString()}`,
      headers: serviceHeaders(request),
      requestId: request.headers.get("x-request-id") ?? undefined,
    });
    return Response.json(result.body, {
      status: result.status,
      headers: responseHeaders(result),
    });
  };
}

export const GET = createAlexaVocListHandler({
  uiEnabled: process.env.MANUAL_ALEXA_VOC_UI_ENABLED === "1",
});
