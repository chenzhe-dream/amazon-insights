import { spawn } from "node:child_process";
import fs from "node:fs";

const pidFile = process.argv[2];
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
fs.writeFileSync(pidFile, String(grandchild.pid), "utf8");
setInterval(() => {}, 1_000);
