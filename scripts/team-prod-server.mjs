import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const vinextServerDir = path.join(root, "node_modules/vinext/dist/server");
const outDir = path.join(root, "dist");
const clientDir = path.join(outDir, "client");

function toWinCacheKey(pathname) {
  return "/" + pathname.slice(1).replace(/\//g, "\\");
}

const { StaticFileCache } = await import(
  pathToFileURL(path.join(vinextServerDir, "static-file-cache.js")).href
);

const originalLookup = StaticFileCache.prototype.lookup;

StaticFileCache.prototype.lookup = function lookupWithWindowsPaths(pathname) {
  const direct = originalLookup.call(this, pathname);
  if (direct) return direct;
  if (process.platform !== "win32") return undefined;
  return this.entries.get(toWinCacheKey(pathname));
};

async function assertClientAssetsReady() {
  const manifestPath = path.join(outDir, "server", "__vite_rsc_assets_manifest.js");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("dist/server 缺失，请先运行 npm run build");
  }

  const manifest = (await import(pathToFileURL(manifestPath).href)).default;
  const bootstrapMatch = manifest.bootstrapScriptContent?.match(/import\("([^"]+\.js)"\)/);
  if (!bootstrapMatch) {
    throw new Error("无法从 dist/server 读取客户端 bootstrap 脚本");
  }

  const cache = await StaticFileCache.create(clientDir);
  const requiredAssets = [...new Set([
    bootstrapMatch[1],
    ...Object.values(manifest.clientReferenceDeps ?? {}).flatMap((entry) => entry.js ?? []),
  ])];
  const missing = requiredAssets.filter((assetPath) => !cache.lookup(assetPath));

  if (missing.length) {
    throw new Error(
      `客户端 JS 资源未就绪（${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " ..." : ""}）。` +
        " 请先 npm run build，再重启服务；仅 build 不重启会导致页面无法切换 VOC / Listing 流量。"
    );
  }

  console.log(`[ok] Client assets verified (${requiredAssets.length} files)`);

  const bootstrapPath = bootstrapMatch[1];
  const bootstrapFile = cache.lookup(bootstrapPath);
  if (!bootstrapFile) {
    throw new Error(`Bootstrap 脚本缺失：${bootstrapPath}。请重新 npm run build 并重启服务。`);
  }
}

await assertClientAssetsReady();

const { startProdServer } = await import(
  pathToFileURL(path.join(vinextServerDir, "prod-server.js")).href
);

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

await startProdServer({ port, host, outDir });
