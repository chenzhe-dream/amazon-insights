import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  XydcOrderSnapshotSchema,
  type XydcOrderSnapshot,
  type XydcOrderWindow,
} from "../../shared/xydc-order-contract";
import { matchesXydcOrderSnapshot } from "../../shared/xydc-order-summary";
import { XydcVariantFamilySchema, type XydcVariantFamily } from "../../shared/xydc-variant-contract";

type FileHandle = { writeFile(data: string): Promise<void>; sync(): Promise<void>; close(): Promise<void> };

export interface XydcOrderFileOps {
  mkdir(filePath: string, options: { recursive: true }): Promise<unknown>;
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  open(filePath: string, flags: "wx"): Promise<FileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  platform?: string;
  delay?(milliseconds: number): Promise<void>;
}

const defaultOps: XydcOrderFileOps = {
  mkdir: fs.mkdir,
  readFile: fs.readFile,
  open: fs.open,
  rename: fs.rename,
  unlink: fs.unlink,
  platform: process.platform,
  delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

function normalizedIdentity(family: XydcVariantFamily, window: XydcOrderWindow) {
  const parsedFamily = XydcVariantFamilySchema.parse(family);
  const country = parsedFamily.country.trim().toUpperCase();
  const parentAsin = parsedFamily.parentAsin.trim().toUpperCase();
  const childAsins = [...parsedFamily.children.map(child => child.asin)].sort();
  if (!/^[A-Z]{2,8}$/.test(country) || !/^[A-Z0-9]{10}$/.test(parentAsin) || childAsins.length === 0) {
    throw new Error("Invalid Xiyou order cache identity");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify({ country, parentAsin, childAsins, window }))
    .digest("hex")
    .slice(0, 20);
  return { country, parentAsin, childAsins, digest };
}

export function xydcOrderCachePath(dataRoot: string, family: XydcVariantFamily, window: XydcOrderWindow) {
  const identity = normalizedIdentity(family, window);
  const filename = `${identity.parentAsin}-${window.startMonth}-${window.endMonth}-${identity.digest}.json`;
  return path.join(path.resolve(dataRoot), "xydc-orders", "v1", identity.country, filename);
}

export function isFreshXydcOrderCache(
  snapshot: XydcOrderSnapshot | undefined,
  now: Date,
  maxAgeMs = 86_400_000,
) {
  if (!snapshot || snapshot.cacheState !== "fresh" || snapshot.reasonCode !== null) return false;
  const age = now.getTime() - Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return false;
  if (snapshot.children.length !== snapshot.childAsins.length) return false;
  const expectedMonths = new Set(snapshot.window.months);
  return snapshot.children.every(child => child.reasonCode === null
    && child.trends.length === snapshot.window.months.length
    && child.trends.every(trend => expectedMonths.has(trend.date)));
}

export async function readXydcOrderSnapshot(
  dataRoot: string,
  family: XydcVariantFamily,
  window: XydcOrderWindow,
  ops: XydcOrderFileOps = defaultOps,
) {
  try {
    const raw = await ops.readFile(xydcOrderCachePath(dataRoot, family, window), "utf8");
    const parsed = XydcOrderSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success && matchesXydcOrderSnapshot(parsed.data, family, window) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeXydcOrderSnapshot(
  dataRoot: string,
  family: XydcVariantFamily,
  snapshot: XydcOrderSnapshot,
  ops: XydcOrderFileOps = defaultOps,
) {
  const parsed = XydcOrderSnapshotSchema.parse(snapshot);
  if (!matchesXydcOrderSnapshot(parsed, family, parsed.window)) {
    throw new Error("Xiyou order cache identity mismatch");
  }
  const target = xydcOrderCachePath(dataRoot, family, parsed.window);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await ops.mkdir(directory, { recursive: true });
  let handle: FileHandle | undefined;
  try {
    handle = await ops.open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(parsed)}\n`);
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

async function renameWithWindowsRetry(temporary: string, target: string, ops: XydcOrderFileOps) {
  const waits = [10, 20, 40, 80, 160];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ops.rename(temporary, target);
      return;
    } catch (error) {
      const code = typeof error === "object" && error ? (error as NodeJS.ErrnoException).code : undefined;
      if (ops.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= waits.length) {
        throw error;
      }
      await (ops.delay ?? defaultOps.delay!)(waits[attempt]!);
    }
  }
}
