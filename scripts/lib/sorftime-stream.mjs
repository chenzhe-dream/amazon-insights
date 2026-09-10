import { spawn } from "node:child_process";
import { parseProviderDiagnosticOutput } from "./provider-diagnostics.mjs";

// Only the directly owned Node process is terminated; no shell/process-tree guessing.
export function runSorftimeCommand({ args, asins, env = process.env, cwd = process.cwd(), timeoutMs,
  onProgress = () => {}, onHeartbeat = () => {} }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = [];
    let timedOut = false;
    let callbackFailed = false;
    const consume = stream => {
      let line = "";
      let discard = false;
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        for (const character of chunk) {
          if (character === "\n") {
            if (!discard) {
              diagnostics = [...diagnostics, ...parseProviderDiagnosticOutput(line)].slice(-64);
              if (line.startsWith("@@sorftime-progress@@")) {
                let value;
                try { value = JSON.parse(line.slice(21)); } catch {}
                if (value && asins.includes(value.asin) && ["collecting", "completed", "partial"].includes(value.state)
                  && Number.isSafeInteger(value.completed) && Number.isSafeInteger(value.total)
                  && value.completed >= 0 && value.total >= value.completed && value.total <= 100_000) {
                  try { onProgress({ asin: value.asin, completed: value.completed, total: value.total, state: value.state }); }
                  catch { callbackFailed = true; child.kill(); }
                }
              }
            }
            line = ""; discard = false;
          } else if (!discard) {
            if (line.length >= 8_192) { line = ""; discard = true; }
            else line += character;
          }
        }
      });
    };
    consume(child.stdout); consume(child.stderr);
    const started = Date.now();
    const heartbeat = setInterval(() => {
      try { onHeartbeat(Math.floor((Date.now()-started)/1_000)); }
      catch { callbackFailed = true; child.kill(); }
    }, 5_000);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(1, timeoutMs));
    let terminationSignal;
    const forward = signal => { terminationSignal = signal; child.kill(signal); };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    child.once("error", () => {});
    child.once("close", code => {
      clearTimeout(timer); clearInterval(heartbeat);
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
      if (terminationSignal) { process.kill(process.pid, terminationSignal); return; }
      if (timedOut) diagnostics.push(...asins.map(asin => ({ connector: "sorftime", stage: "child_sales", asin,
        failureKind: "timeout", causeCode: "REQUEST_TIMEOUT" })));
      resolve({ succeeded: code === 0 && !timedOut && !callbackFailed, diagnostics });
    });
  });
}
