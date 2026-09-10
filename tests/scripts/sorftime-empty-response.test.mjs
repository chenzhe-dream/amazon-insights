import assert from "node:assert/strict";
import test from "node:test";
import { callSorftimeTool, projectSorftimeConsumerCandidate } from "../../scripts/lib/sorftime-mcp-client.mjs";
import { parseVariationRows } from "../../scripts/build-sorftime-child-sales.mjs";

function call(name, result) {
  return callSorftimeTool("fixture-key", name, { asin: "B0F43M9KWW", amz_site: "US" }, {
    env: { NODE_ENV: "test" },
    fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result })),
  });
}
const textResult = text => ({ content: [{ type: "text", text }] });

test("observed Customers Say no-data message is an empty summary, not a failed review request", async () => {
  const result = await call("product_customers_say", textResult("No relevant data."));
  assert.deepEqual(await projectSorftimeConsumerCandidate("product_customers_say", {}, result), { details: [] });
});

test("observed variations no-data message is a recognized empty source, never a zero-sales row", async () => {
  const result = await call("product_variations", textResult("No data available."));
  assert.deepEqual(parseVariationRows(result), { containerRecognized: true, rawRowCount: 0, validSalesRowCount: 0, rows: [] });
});

test("unrecognized or ambiguous text remains fail-closed", async () => {
  for (const [name, result] of [
    ["product_customers_say", textResult("No data available.")],
    ["product_reviews", textResult("No relevant data.")],
    ["product_variations", textResult("Unauthorized. No data available.")],
    ["product_variations", textResult("<html>No data available.</html>")],
    ["product_variations", textResult("not-json")],
    ["product_variations", { ...textResult("No data available."), structuredContent: { data: [{ Asin: "B0F43M9KWW" }] } }],
    ["product_variations", { content: [...textResult("No data available.").content, { type: "text", text: "permission denied" }] }],
  ]) await assert.rejects(call(name, result));
});

test("explicit tool errors are never accepted even if their body looks like valid empty JSON", async () => {
  for (const text of ["No data available.", '{"data":[]}']) {
    await assert.rejects(call("product_variations", { ...textResult(text), isError: true }), error => error.kind === "rpc");
  }
});

test("valid JSON data remains unchanged", async () => {
  const data = { data: [{ Asin: "B0F43M9KWW", SalesAmount: 12, Property: "Color: Black" }] };
  assert.deepEqual(await call("product_variations", textResult(JSON.stringify(data))), data);
});

test("observed product_reviews no-review message is empty without inventing reviews", async () => {
  assert.deepEqual(await call("product_reviews", textResult("No reviews found.")), { data: [] });
  for (const result of [
    textResult("No reviews found. Retry later"),
    { ...textResult("No reviews found."), isError: true },
    { ...textResult("No reviews found."), structuredContent: { data: [] } },
    { content: [...textResult("No reviews found.").content, ...textResult("other").content] },
  ]) await assert.rejects(call("product_reviews", result));
});
