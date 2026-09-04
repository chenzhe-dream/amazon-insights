import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { XydcVariantFamilySchema, type XydcVariantFamily } from "../../shared/xydc-variant-contract";

export function xydcVariantCachePath(dataRoot: string, country: string, inputAsin: string) {
  const safeCountry = country.trim().toUpperCase();
  const safeAsin = inputAsin.trim().toUpperCase();
  if (!/^[A-Z]{2,8}$/.test(safeCountry) || !/^[A-Z0-9]{10}$/.test(safeAsin)) {
    throw new Error("Invalid Xiyou variant cache identity");
  }
  return path.join(path.resolve(dataRoot), "xydc-variants", safeCountry, `${safeAsin}.json`);
}

export function isFreshXydcVariantCache(family: XydcVariantFamily | undefined, now: Date, maxAgeMs = 86_400_000) {
  return family?.status === "ready"
    && now.getTime() - Date.parse(family.fetchedAt) <= maxAgeMs;
}

type FileHandle = { writeFile(data: string): Promise<void>; sync(): Promise<void>; close(): Promise<void> };
export interface XydcVariantFileOps {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  open(path: string, flags: "wx"): Promise<FileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  platform?: string;
  sleep?(ms: number): Promise<void>;
}

const defaultOps: XydcVariantFileOps = {
  mkdir: fs.mkdir,
  readFile: fs.readFile,
  open: fs.open,
  rename: fs.rename,
  unlink: fs.unlink,
  platform: process.platform,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

export async function readXydcVariantFamily(
  dataRoot: string,
  country: string,
  inputAsin: string,
  ops: XydcVariantFileOps = defaultOps,
) {
  try {
    const expectedInputAsin = inputAsin.trim().toUpperCase();
    const parsed = XydcVariantFamilySchema.safeParse(JSON.parse(await ops.readFile(xydcVariantCachePath(dataRoot, country, inputAsin), "utf8")));
    return parsed.success && parsed.data.inputAsin === expectedInputAsin ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeXydcVariantFamily(
  dataRoot: string,
  country: string,
  family: XydcVariantFamily,
  ops: XydcVariantFileOps = defaultOps,
) {
  const target = xydcVariantCachePath(dataRoot, country, family.inputAsin);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await ops.mkdir(directory, { recursive: true });
  let handle: FileHandle | undefined;
  try {
    handle = await ops.open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(XydcVariantFamilySchema.parse(family))}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithWindowsRetry(temporary, target, ops);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await ops.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function renameWithWindowsRetry(temporary: string, target: string, ops: XydcVariantFileOps) {
  const waits = [10, 20, 40, 80, 160];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ops.rename(temporary, target);
      return;
    } catch (error) {
      const code = typeof error === "object" && error ? (error as NodeJS.ErrnoException).code : undefined;
      if (ops.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= waits.length) throw error;
      await (ops.sleep ?? defaultOps.sleep!)(waits[attempt]);
    }
  }
}

export function createXydcVariantCache(dataRoot: string, ops: XydcVariantFileOps = defaultOps) {
  return Object.freeze({
    async readMany(country: string, asins: readonly string[]) {
      const rows = await Promise.all(asins.map(async asin => [asin, await readXydcVariantFamily(dataRoot, country, asin, ops)] as const));
      return Object.fromEntries(rows.filter(([, family]) => family)) as Record<string, XydcVariantFamily>;
    },
    async write(country: string, family: XydcVariantFamily) {
      await writeXydcVariantFamily(dataRoot, country, family, ops);
    },
  });
}
