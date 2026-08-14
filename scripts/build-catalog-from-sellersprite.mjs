import { asinsNeedingCatalogSync, readCatalogAsins, syncCatalogAsins } from "./lib/catalog-sync.mjs";

async function main() {
  const marketplace = process.env.SELLERSPRITE_MARKETPLACE ?? process.env.MARKETPLACE ?? "US";
  const fromEnv = process.env.SELLERSPRITE_ASINS?.split(",").map(item => item.trim().toUpperCase()).filter(Boolean) ?? [];
  const fromArgv = process.argv.slice(2).map(item => item.trim().toUpperCase()).filter(item => /^[A-Z0-9]{10}$/.test(item));
  const asins = [...new Set([...fromEnv, ...fromArgv])];

  if (!asins.length) {
    console.error("[error] 请指定 ASIN：SELLERSPRITE_ASINS=B0XXXXXXXXXX npm run catalog:sync");
    process.exit(1);
  }

  const pending = asinsNeedingCatalogSync(asins);
  const result = await syncCatalogAsins(asins, marketplace);
  console.log(`[done] catalog +${result.added.length} · total ${readCatalogAsins().length} ASINs`);
  if (pending.length && result.added.length < pending.length) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
