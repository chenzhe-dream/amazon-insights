import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const amazonAuthFile = path.join(root, "data", "amazon-auth.json");

function hasOpenAiConfigured() {
  if (process.env.OPENAI_API_KEY?.trim()) return true;
  const keyFile = path.join(root, "data", "openai-api-key.txt");
  if (fs.existsSync(keyFile) && fs.readFileSync(keyFile, "utf8").trim()) return true;
  for (const rel of [".env", ".env.local", path.join("data", ".env")]) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    if (/(?:^|\n)\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*\S+/m.test(fs.readFileSync(file, "utf8"))) return true;
  }
  return false;
}

export function getSystemCapabilities() {
  const alexaAutoEnv = process.env.ALEXA_AUTO !== "0";
  const hasAmazonAuth = fs.existsSync(amazonAuthFile);
  const hasCdp = Boolean(process.env.ALEXA_CDP_URL?.trim());
  const alexaServerAuto = alexaAutoEnv && (hasAmazonAuth || hasCdp);
  const hasOpenAI = hasOpenAiConfigured();

  let amazonAuthUpdatedAt: string | null = null;
  if (hasAmazonAuth) {
    try {
      amazonAuthUpdatedAt = fs.statSync(amazonAuthFile).mtime.toISOString();
    } catch {
      amazonAuthUpdatedAt = null;
    }
  }

  return {
    alexaServerAuto,
    alexaAutoEnv,
    hasAmazonAuth,
    hasCdp,
    amazonAuthUpdatedAt,
    hasOpenAI,
    teamMode: true,
    colleagueFlow:
      "在浏览器输入 3–10 个 ASIN 并点击「开始全自动分析」，系统将自动入库、拉取 MCP 数据并采集 Alexa VOC，完成后页面自动刷新。",
    alexaServerNote: alexaServerAuto
      ? "服务器已配置 Amazon 会话，Alexa VOC 可在后台全自动采集。"
      : "服务器尚未配置 Amazon 会话；VOC 将通过您本机 Chrome（已登录 Amazon）自动采集。",
  };
}
