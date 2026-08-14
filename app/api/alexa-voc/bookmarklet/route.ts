import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceFile = path.join(root, "public", "alexa-voc-capture.js");

export async function GET() {
  const source = fs.readFileSync(sourceFile, "utf8");
  const bookmarklet = `javascript:${encodeURIComponent(source.replace(/\s+/g, " ").trim())}`;
  return Response.json({
    bookmarklet,
    sourcePath: "/alexa-voc-capture.js",
    hint: "将 bookmarklet 链接拖到 Chrome 书签栏；在 Amazon 商品页点击即可自动采集并回传。",
  });
}
