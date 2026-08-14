import { execSync, spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = process.env.PORT ?? "3000";

function pidsOnPort(localPort) {
  try {
    const out = execSync(`netstat -ano`, { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      if (!line.includes(`:${localPort}`)) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid) && Number(pid) > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

for (const pid of pidsOnPort(port)) {
  console.log(`[restart] stopping PID ${pid} on :${port}`);
  try {
    execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

const child = spawn("npm", ["start"], {
  cwd: root,
  env: { ...process.env, PORT: port, ALEXA_AUTO: "1", HOST: "0.0.0.0" },
  detached: true,
  stdio: "ignore",
  shell: true,
});
child.unref();
console.log(`[restart] started npm start on :${port}`);
