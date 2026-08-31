import { ManualAlexaVocImportRequestSchema } from "../../../../shared/agent-contracts";
import { authorizeWebMutation } from "../../../lib/authenticated-web-mutation";
import {
  createAgentServiceClient,
  type AgentServiceClient,
  type AgentServiceResult,
} from "../../../lib/agent-service-client";

const MAX_IMPORT_BODY_BYTES = 256 * 1024;

type ImportDependencies = Readonly<{
  authorize: typeof authorizeWebMutation;
  client: AgentServiceClient;
  uiEnabled: boolean;
}>;

async function readBoundedBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BODY_BYTES) {
    throw new RangeError("body");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_IMPORT_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("body");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

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

export function createAlexaVocImportHandler(
  dependencies: Partial<ImportDependencies> = {},
) {
  const authorize = dependencies.authorize ?? authorizeWebMutation;
  const client = dependencies.client ?? createAgentServiceClient();
  const uiEnabled = dependencies.uiEnabled ?? true;

  return async function handleAlexaVocImport(request: Request) {
    const authorization = await authorize(request, {
      allowedRoles: ["admin", "member"],
      client,
    });
    if (!authorization.ok) return authorization.response;
    if (!uiEnabled) {
      return Response.json(
        { error: "Manual Alexa VOC 录入功能暂未启用，请联系管理员" },
        { status: 503 },
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(await readBoundedBody(request));
    } catch (error) {
      return error instanceof RangeError && error.message === "body"
        ? Response.json({ error: "请求内容过大" }, { status: 413 })
        : Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return Response.json({ error: "请求内容必须是对象" }, { status: 400 });
    }
    const parsed = ManualAlexaVocImportRequestSchema.safeParse({
      marketplace: "US",
      ...(value as Record<string, unknown>),
    });
    if (!parsed.success) {
      return Response.json({ error: "Alexa VOC 导入请求无效" }, { status: 400 });
    }

    const result = await client({
      method: "POST",
      path: "/v1/manual-alexa-voc/import",
      headers: serviceHeaders(request),
      body: JSON.stringify(parsed.data),
      requestId: request.headers.get("x-request-id") ?? undefined,
    });
    return Response.json(result.body, {
      status: result.status,
      headers: responseHeaders(result),
    });
  };
}

export const POST = createAlexaVocImportHandler({
  uiEnabled: process.env.MANUAL_ALEXA_VOC_UI_ENABLED === "1",
});
