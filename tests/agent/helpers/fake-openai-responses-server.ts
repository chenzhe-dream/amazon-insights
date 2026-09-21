import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

/** Exercises the real Responses transport against a deterministic loopback provider. */
export async function startFakeOpenAIResponsesServer(
  respond: (body: { input: string; model?: string }) => unknown | Promise<unknown>,
) {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || !("input" in body) || typeof body.input !== "string") {
        throw new Error("Expected a serialized Responses input");
      }
      const output = await respond({ input: body.input, model: "model" in body && typeof body.model === "string" ? body.model : undefined });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: `resp_${randomUUID()}`, object: "response", status: "completed",
        output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] }],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fake provider address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
