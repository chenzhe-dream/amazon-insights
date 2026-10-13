import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const server = await createServer({ configFile: false, define: { "process.env": "{}" }, plugins: [react()], server: { host: "127.0.0.1", port: 31909, strictPort: true } });
await server.listen();
console.log("Local UI harness: http://127.0.0.1:31909/tests/agent/helpers/balance-board-overview-harness.html");
