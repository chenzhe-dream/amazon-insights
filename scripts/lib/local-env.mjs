import fs from "node:fs";
import path from "node:path";
import { getProjectRoot } from "./project-root.mjs";

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const source = fs.readFileSync(filePath, "utf8");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

/** 把仓库根目录的 .env / .env.local / data 密钥文件灌进 process.env（不覆盖已有变量） */
export function loadLocalEnv() {
  if (process.env.AGENT_FORMAL_WORKTREE_ROOT !== undefined) return;
  const root = getProjectRoot();
  parseEnvFile(path.join(root, ".env"));
  parseEnvFile(path.join(root, ".env.local"));
  parseEnvFile(path.join(root, "data", ".env"));

  const keyFile = path.join(root, "data", "openai-api-key.txt");
  if (fs.existsSync(keyFile)) {
    const fromFile = fs.readFileSync(keyFile, "utf8").trim();
    if (fromFile && !process.env.OPENAI_API_KEY?.trim()) {
      process.env.OPENAI_API_KEY = fromFile;
    }
  }
}

export function hasOpenAiKey() {
  loadLocalEnv();
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}
